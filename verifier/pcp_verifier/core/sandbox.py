"""Isolated shadow copies of the user's repo, where patches are applied and tests run.

The user's real files are only ever *read* (copied). All writes happen in a
fresh temp folder per attempt, which is always deleted afterwards.

Backends:
  * LocalTempSandbox (default): temp-dir copy + subprocess. Network is denied
    on a best-effort basis only (proxy vars point at a dead port).
  * DockerSandbox (PCP_SANDBOX=docker): same copy, tests run inside
    `docker run --network none`, which gives real network isolation.
"""

from __future__ import annotations

import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

COPY_IGNORE = shutil.ignore_patterns(
    ".git", ".hg", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".tox", ".nox", "htmlcov", ".coverage",
)  # fmt: skip
DEAD_PROXY = "http://127.0.0.1:9"
IS_WINDOWS = os.name == "nt"


class SandboxCancelled(RuntimeError):
    pass


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_s: float
    timed_out: bool = False

    @property
    def output(self) -> str:
        return (self.stdout + ("\n" + self.stderr if self.stderr else "")).strip()


def _rm_readonly(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=15,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        proc.kill()


class LocalTempSandbox:
    """One shadow copy. Create one per baseline/patched run and per attempt."""

    kind = "local-temp"

    def __init__(self, repo_root: str | Path, label: str = "shadow", python: str | None = None):
        self.repo_root = Path(repo_root).resolve()
        if not self.repo_root.is_dir():
            raise FileNotFoundError(f"repo_root does not exist: {self.repo_root}")
        self.python = python or os.environ.get("PCP_TARGET_PYTHON") or sys.executable
        self.base = Path(tempfile.mkdtemp(prefix=f"pcp-{label}-"))
        self.work = self.base / "repo"
        self._procs: set[subprocess.Popen] = set()
        self._lock = threading.Lock()
        self.cancelled = False

    @property
    def name(self) -> str:
        return self.kind

    # ------------------------------------------------------------ lifecycle
    def prepare(self) -> None:
        shutil.copytree(self.repo_root, self.work, ignore=COPY_IGNORE, symlinks=True)

    def apply(self, diff: str) -> tuple[bool, str]:
        """git apply the diff inside the shadow. Returns (ok, message)."""
        if not diff.strip():
            return True, "nothing to apply"
        patch = self.base / "patch.diff"
        patch.write_bytes(diff.encode("utf-8"))
        last = ""
        for extra in ([], ["--ignore-whitespace"]):  # second try tolerates CRLF checkouts
            check = self.exec(["git", "apply", "--check", *extra, str(patch)], timeout=30)
            if check.exit_code == 0:
                done = self.exec(["git", "apply", *extra, str(patch)], timeout=30)
                return done.exit_code == 0, done.output or "applied"
            last = check.output
        return False, f"git apply failed: {last}"

    def cleanup(self) -> None:
        self.kill()
        shutil.rmtree(self.base, onerror=_rm_readonly)

    def kill(self) -> None:
        self.cancelled = True
        with self._lock:
            procs = list(self._procs)
        for p in procs:
            _kill_tree(p)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.cleanup()

    # ------------------------------------------------------------ execution
    def env(self) -> dict[str, str]:
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.upper().startswith(("PCP_", "PYTEST_ADDOPTS", "VIRTUAL_ENV"))
            and "API_KEY" not in k.upper()
            and "TOKEN" not in k.upper()
            and "SECRET" not in k.upper()
        }
        src = self.work / "src"
        paths = [str(src)] if src.is_dir() else []
        env.update(
            PYTHONPATH=os.pathsep.join([*paths, str(self.work)]),
            PYTHONDONTWRITEBYTECODE="1",
            PYTHONHASHSEED="0",
            PIP_NO_INDEX="1",
            HTTP_PROXY=DEAD_PROXY,
            HTTPS_PROXY=DEAD_PROXY,
            http_proxy=DEAD_PROXY,
            https_proxy=DEAD_PROXY,
            NO_PROXY="",
            no_proxy="",
        )
        return env

    def command(self, args: list[str]) -> list[str]:
        return args

    def exec(self, args: list[str], timeout: float, cwd: Path | None = None) -> ExecResult:
        if self.cancelled:
            raise SandboxCancelled("sandbox was cancelled")
        kwargs: dict = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        start = time.monotonic()
        proc = subprocess.Popen(
            self.command(args),
            cwd=str(cwd or self.work),
            env=self.env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            **kwargs,
        )
        with self._lock:
            self._procs.add(proc)
        timed_out = False
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(proc)
            out, err = proc.communicate()
        finally:
            with self._lock:
                self._procs.discard(proc)
        if self.cancelled:
            raise SandboxCancelled("sandbox was cancelled")
        return ExecResult(
            exit_code=-1 if timed_out else proc.returncode,
            stdout=out.decode("utf-8", "replace"),
            stderr=err.decode("utf-8", "replace"),
            duration_s=round(time.monotonic() - start, 3),
            timed_out=timed_out,
        )

    def python_cmd(self, *args: str) -> list[str]:
        return [self.python, *args]


class DockerSandbox(LocalTempSandbox):
    """Runs Python inside `docker run --network none`; git apply still runs on the host copy."""

    kind = "docker"

    def __init__(self, repo_root, label="shadow", image: str | None = None, **_):
        super().__init__(repo_root, label)
        self.image = image or os.environ.get("PCP_DOCKER_IMAGE", "pcp-sandbox:py312")
        self.container = f"pcp-{uuid.uuid4().hex[:12]}"

    @property
    def name(self) -> str:
        return f"docker:{self.image}"

    def python_cmd(self, *args: str) -> list[str]:
        return [
            "docker", "run", "--rm", "--name", self.container, "--network", "none",
            "--memory", "2g", "--cpus", "2",
            "-e", "PYTHONPATH=/w/src:/w", "-e", "PYTHONDONTWRITEBYTECODE=1",
            "-v", f"{self.base}:/sandbox", "-v", f"{self.work}:/w", "-w", "/w",
            self.image, "python", *[a.replace(str(self.base), "/sandbox") for a in args],
        ]  # fmt: skip

    def kill(self) -> None:
        super().kill()
        subprocess.run(["docker", "kill", self.container], capture_output=True, timeout=15)


def make_sandbox(repo_root: str | Path, label: str) -> LocalTempSandbox:
    if os.environ.get("PCP_SANDBOX", "local").lower() == "docker":
        return DockerSandbox(repo_root, label)
    return LocalTempSandbox(repo_root, label)
