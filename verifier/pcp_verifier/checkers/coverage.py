"""Coverage checker: is the changed source code actually exercised by tests?

1. Mapping: each changed source file should have a related test file
   (test_<stem>.py or a test importing the module), touched or proven by F2P.
2. Optional coverage.py run (PCP_COVERAGE=1, default) in the patched shadow:
   added executable lines that no test runs are flagged.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from pcp_verifier.checkers.common import ResultBuilder, current_sandbox, parsed
from pcp_verifier.contracts import CheckResult, PatchContext
from pcp_verifier.core.proof_runner import COVERAGE_JSON, related_test_files

NAME = "coverage"
M_NO_TEST_FILE = 50
M_TEST_NOT_TOUCHED = 30
M_UNEXECUTED_MAX = 60
COVERAGE_TIMEOUT_S = 25


def _source_files(ctx):
    return [
        f
        for f in parsed(ctx).files
        if not f.is_test and f.path.endswith(".py") and not f.is_removed
    ]


def _read_cov(sb, cov_file) -> dict:
    files = json.loads(cov_file.read_text(encoding="utf-8")).get("files", {})
    out = {}
    for path, info in files.items():
        rel = sb.to_rel(path)
        if rel is not None:  # None = outside the shadow (e.g. site-packages)
            out[rel] = set(info.get("missing_lines", []))
    return out


def _coverage_run(sb, sources: list[str], tests: list[str]) -> dict | None:
    """Coverage of the changed sources. Reuses the proof run's data when present,
    otherwise runs the related tests under coverage.py in the registered sandbox."""
    reused = sb.base / COVERAGE_JSON
    if reused.is_file():
        return _read_cov(sb, reused)
    cov_file = sb.base / "cov-checker.json"
    data_file = sb.base / ".coverage"
    include = ",".join(str(sb.work / s) for s in sources)
    no_dev = ["-p", "no:asyncio"] if sb.python == sys.executable else []
    run = sb.exec(
        sb.python_cmd(
            "-m", "coverage", "run", f"--data-file={data_file}", f"--include={include}",
            "-m", "pytest", "-q", "-p", "no:cacheprovider", *no_dev, "--no-header", *tests,
        ),
        timeout=COVERAGE_TIMEOUT_S,
    )  # fmt: skip
    if run.timed_out or "No module named coverage" in run.output:
        return None
    rep = sb.exec(
        sb.python_cmd("-m", "coverage", "json", f"--data-file={data_file}", "-o", str(cov_file)),
        timeout=15,
    )
    if rep.exit_code != 0 or not cov_file.is_file():
        return None
    return _read_cov(sb, cov_file)


async def run(ctx: PatchContext) -> CheckResult:
    r = ResultBuilder(NAME)
    sources = _source_files(ctx)
    if not sources:
        return r.build()
    p = parsed(ctx)
    proof = ctx.proof
    proven = bool(proof and proof.f2p_ok)
    touched_tests = {f.path for f in p.test_files}
    related_all: set[str] = set()

    for src in sources:
        related = await asyncio.to_thread(related_test_files, _root(ctx), [src.path])
        related_all |= set(related)
        first = src.added[0][0] if src.added else None
        if not related and not touched_tests:
            r.add(
                M_NO_TEST_FILE,
                type="missing_test",
                source="heuristic",
                confidence=0.7,
                file=src.path,
                line_start=first,
                line_end=first,
                message=f"No test file covers {src.path}",
                action=f"Add tests for {src.path}",
            )
        elif not proven and not (set(related) & touched_tests):
            r.add(
                M_TEST_NOT_TOUCHED,
                type="missing_test",
                source="heuristic",
                confidence=0.6,
                file=src.path,
                line_start=first,
                line_end=first,
                message=f"{src.path} changed but its tests ({', '.join(related[:3]) or 'none'}) were not updated",
                action="Extend the related tests to cover the change",
            )

    sb = current_sandbox.get()
    tests = sorted(related_all | {t for t in touched_tests if t.endswith(".py")})
    if sb is not None and tests and os.environ.get("PCP_COVERAGE", "1") == "1":
        missing = await asyncio.to_thread(_coverage_run, sb, [s.path for s in sources], tests)
        if missing is not None:
            total = unexecuted = 0
            for src in sources:
                miss = missing.get(src.path, set())
                added = [
                    (n, t) for n, t in src.added if t.strip() and not t.strip().startswith("#")
                ]
                total += len(added)
                lines = [n for n, _ in added if n in miss]
                unexecuted += len(lines)
                if lines:
                    r.add(
                        0,
                        type="missing_test",
                        source="tool",
                        confidence=0.9,
                        file=src.path,
                        line_start=lines[0],
                        line_end=lines[-1],
                        evidence=next(t for n, t in src.added if n == lines[0]).strip()[:200],
                        message=f"{len(lines)} changed line(s) in {src.path} never run in tests: {lines[:10]}",
                        action="Add a test that executes the new lines",
                    )
            if total and unexecuted:
                r.bump(round(M_UNEXECUTED_MAX * unexecuted / total))
    return r.build()


def _root(ctx: PatchContext):

    shadow = Path(ctx.shadow_root)
    return shadow if shadow.is_dir() else Path(ctx.repo_root)
