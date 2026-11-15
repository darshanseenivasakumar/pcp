"""Proof by execution: baseline vs patched test runs in fresh shadow copies.

* baseline = original source + ONLY the patch's test-file changes, so new
  (F2P) tests run against the old code and must fail there;
* patched  = original source + the whole patch.

The host runs pytest and parses the junit XML itself; nothing a model says
about test results is ever used. Every attempt's diff is relative to the
user's original repo (nothing reaches disk before a hunk is accepted).
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from pcp_verifier.contracts import FrozenManifest, Proof, RunResult
from pcp_verifier.core.diffparse import DiffError, ParsedDiff, is_test_path, only_files, parse_diff
from pcp_verifier.core.sandbox import LocalTempSandbox, make_sandbox
from pcp_verifier.core.testscan import (
    TestFingerprint,
    detect_tampering,
    function_id,
    new_or_changed,
    parse_junit,
    scan_files,
)

OUTPUT_TAIL = 3000
Emit = Callable[[str, dict], None]


@dataclass
class FrozenState:
    """What attempt 1 froze, carried along the repair chain."""

    manifest: FrozenManifest = field(default_factory=FrozenManifest)
    fingerprints: dict[str, TestFingerprint] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "manifest": self.manifest.model_dump(),
            "fingerprints": {k: v.to_dict() for k, v in self.fingerprints.items()},
        }

    @classmethod
    def from_dict(cls, d: dict) -> FrozenState:
        return cls(
            manifest=FrozenManifest.model_validate(d["manifest"]),
            fingerprints={k: TestFingerprint.from_dict(v) for k, v in d["fingerprints"].items()},
        )


@dataclass
class ProofOutcome:
    proof: Proof
    frozen: FrozenState
    parsed: ParsedDiff | None
    patched_sandbox: LocalTempSandbox | None  # kept alive for checkers; caller cleans up
    regressions: list[str] = field(default_factory=list)


def _timeout() -> float:
    return float(os.environ.get("PCP_TEST_TIMEOUT_S", "120"))


def _pytest_args(sb: LocalTempSandbox, selection: list[str]) -> list[str]:
    junit = sb.base / "junit.xml"
    args = [
        "-m", "pytest", "-q", "-rfE", "--tb=short", "-p", "no:cacheprovider",
        "-o", "junit_family=xunit1", f"--junitxml={junit}", f"--rootdir={sb.work}",
    ]  # fmt: skip
    import sys

    if sb.python == sys.executable:
        args += ["-p", "no:asyncio"]  # our own dev plugin must not leak into the target repo
    extra = os.environ.get("PCP_PYTEST_ARGS", "").split()
    return sb.python_cmd(*args, *extra, *selection)


def _run_tests(sb: LocalTempSandbox, selection: list[str]) -> RunResult:
    present = [s for s in selection if (sb.work / s).exists()]
    if selection and not present:
        present = []  # everything selected was deleted: run the default suite instead
    res = sb.exec(_pytest_args(sb, present), timeout=_timeout())
    tests = parse_junit(sb.base / "junit.xml")
    counts = {
        k: sum(1 for o in tests.values() if o == k)
        for k in ("passed", "failed", "skipped", "error")
    }
    tail = res.output[-OUTPUT_TAIL:]
    if res.timed_out:
        tail = f"[pcp] test run timed out after {_timeout():.0f}s\n" + tail
    return RunResult(
        exit_code=res.exit_code,
        passed=counts["passed"],
        failed=counts["failed"],
        skipped=counts["skipped"],
        errors=counts["error"],
        duration_s=res.duration_s,
        tests=tests,
        output_tail=tail,
    )


def _selection(parsed: ParsedDiff, work: Path) -> list[str]:
    """Which test files to run. Default (PCP_TEST_SCOPE=full) is the whole suite."""
    if os.environ.get("PCP_TEST_SCOPE", "full") == "full":
        return []
    files = {f.path for f in parsed.test_files if f.path.endswith(".py")}
    files |= set(related_test_files(work, [f.path for f in parsed.source_files]))
    return sorted(files)


def related_test_files(work: Path, sources: list[str]) -> list[str]:
    """Map changed sources to test files: by name (test_<stem>.py) or by import."""
    candidates = [
        p.relative_to(work).as_posix()
        for p in work.rglob("test*.py")
        if is_test_path(p.relative_to(work).as_posix()) and ".venv" not in p.parts
    ]
    out = set()
    for src in sources:
        if not src.endswith(".py"):
            continue
        stem = Path(src).stem
        mod = src.removesuffix(".py").removeprefix("src/").replace("/", ".")
        for cand in candidates:
            name = Path(cand).name
            if name in {f"test_{stem}.py", f"test_{stem}s.py"}:
                out.add(cand)
                continue
            try:
                text = (work / cand).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if mod in text:
                out.add(cand)
    return sorted(out)


def _case_outcomes(run: RunResult | None, fid: str) -> list[str]:
    if run is None:
        return []
    return [o for t, o in run.tests.items() if function_id(t) == fid]


def classify(
    f2p: list[str], baseline: RunResult, patched: RunResult
) -> tuple[bool, bool, list[str]]:
    """Return (f2p_ok, p2p_ok, regressions)."""
    f2p_set = set(f2p)
    f2p_ok = bool(f2p)
    for fid in f2p:
        before, after = _case_outcomes(baseline, fid), _case_outcomes(patched, fid)
        if not after or any(o != "passed" for o in after):
            f2p_ok = False  # must pass on new code (every case)
        if not before or all(o == "passed" for o in before):
            f2p_ok = False  # must fail on old code (at least one case), else it proves nothing
    regressions = sorted(
        t
        for t, o in baseline.tests.items()
        if o == "passed"
        and function_id(t) not in f2p_set
        and patched.tests.get(t) != "passed"
        and not t.startswith("<collection>")
    )
    collection_errors = any(t.startswith("<collection>") for t in patched.tests)
    p2p_ok = not regressions and not collection_errors and patched.exit_code in (0, 1, 5)
    return f2p_ok, p2p_ok, regressions


async def run_proof(
    *,
    repo_root: str | Path,
    diff: str,
    attempt: int = 1,
    frozen: FrozenState | None = None,
    emit: Emit | None = None,
    register: Callable[[LocalTempSandbox], None] | None = None,
    sandbox_factory: Callable[[str | Path, str], LocalTempSandbox] = make_sandbox,
) -> ProofOutcome:
    emit = emit or (lambda _m, _d: None)
    frozen = frozen or FrozenState()
    repo_root = Path(repo_root).resolve()
    sandbox_name = "local-temp"

    def fail(msg: str, parsed=None) -> ProofOutcome:
        proof = Proof(
            attempt=attempt, sandbox=sandbox_name, frozen_manifest=frozen.manifest,
            f2p_ok=False, p2p_ok=False, apply_ok=False, error=msg,
        )  # fmt: skip
        return ProofOutcome(proof=proof, frozen=frozen, parsed=parsed, patched_sandbox=None)

    try:
        parsed = parse_diff(diff)
    except DiffError as e:
        return fail(str(e))

    base_sb = sandbox_factory(repo_root, "baseline")
    patched_sb = sandbox_factory(repo_root, "patched")
    sandbox_name = patched_sb.name
    for sb in (base_sb, patched_sb):
        if register:
            register(sb)
    keep_patched = False
    try:
        emit("Copying repo to shadow folders", {"sandbox": sandbox_name})
        await asyncio.gather(
            asyncio.to_thread(base_sb.prepare), asyncio.to_thread(patched_sb.prepare)
        )

        ok, msg = await asyncio.to_thread(patched_sb.apply, diff)
        if not ok:
            return fail(msg, parsed)
        test_diff = only_files(parsed, parsed.test_files)
        ok, msg = await asyncio.to_thread(base_sb.apply, test_diff)
        if not ok:
            return fail(f"test-only part of the patch did not apply to the old code: {msg}", parsed)

        # --- static view: which tests are new (F2P) and which are protected
        changed_tests = [f.path for f in parsed.test_files if f.path.endswith(".py")]
        frozen_files = sorted({t.split("::")[0] for t in frozen.manifest.f2p})
        scan = sorted(set(changed_tests) | set(frozen_files))
        original_fps = scan_files(repo_root, scan)
        patched_fps = scan_files(patched_sb.work, scan)
        new_tests = new_or_changed(original_fps, patched_fps)
        f2p = sorted(set(frozen.manifest.f2p) | set(new_tests))
        protected = {**original_fps, **frozen.fingerprints}

        # --- run both trees in parallel
        selection = _selection(parsed, patched_sb.work)
        emit("Running baseline (old code + new tests) and patched tests", {"f2p": len(f2p)})
        baseline, patched = await asyncio.gather(
            asyncio.to_thread(_run_tests, base_sb, selection),
            asyncio.to_thread(_run_tests, patched_sb, selection),
        )

        f2p_ok, p2p_ok, regressions = classify(f2p, baseline, patched)
        tampering = detect_tampering(protected, patched_fps, patched)
        if tampering:
            f2p_ok = f2p_ok and not any(t.test_id in f2p for t in tampering)

        ran_files = sorted({t.split("::")[0] for t in patched.tests if not t.startswith("<")})
        manifest = FrozenManifest(f2p=f2p, p2p=ran_files or selection)
        new_frozen = FrozenState(
            manifest=manifest,
            fingerprints={
                **{t: patched_fps[t] for t in new_tests if t in patched_fps},
                **frozen.fingerprints,  # first freeze wins: later attempts can't loosen it
            },
        )
        proof = Proof(
            attempt=attempt,
            sandbox=sandbox_name,
            frozen_manifest=manifest,
            baseline=baseline,
            patched=patched,
            f2p_ok=f2p_ok,
            p2p_ok=p2p_ok,
            tampering=tampering,
        )
        keep_patched = True
        return ProofOutcome(
            proof=proof,
            frozen=new_frozen,
            parsed=parsed,
            patched_sandbox=patched_sb,
            regressions=regressions,
        )
    finally:
        await asyncio.to_thread(base_sb.cleanup)
        if not keep_patched:
            await asyncio.to_thread(patched_sb.cleanup)
