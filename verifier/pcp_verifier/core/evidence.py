"""Per-hunk evidence: which tests back each hunk, did they pass, which findings point at it."""

from __future__ import annotations

from pathlib import Path

from pcp_verifier.contracts import CheckResult, Hunk, HunkEvidence, Proof
from pcp_verifier.core.diffparse import ParsedDiff
from pcp_verifier.core.proof_runner import related_test_files
from pcp_verifier.core.testscan import function_id
from pcp_verifier.core.verdict import live_findings


def _overlaps(h: Hunk, start: int | None, end: int | None) -> bool:
    if start is None:
        return True  # file-level finding applies to every hunk of the file
    end = end if end is not None else start
    new_lo, new_hi = h.new_start, h.new_start + max(h.new_lines, 1) - 1
    old_lo, old_hi = h.old_start, h.old_start + max(h.old_lines, 1) - 1
    return (start <= new_hi and end >= new_lo) or (start <= old_hi and end >= old_lo)


def _outcomes(proof: Proof | None, test_ids: list[str]) -> list[str]:
    if not proof or not proof.patched:
        return []
    wanted = set(test_ids)
    files = {t for t in test_ids if "::" not in t}
    return [
        o
        for t, o in proof.patched.tests.items()
        if function_id(t) in wanted or t.split("::")[0] in files
    ]


def build_hunk_evidence(
    parsed: ParsedDiff | None, proof: Proof | None, checks: list[CheckResult], root: Path | None
) -> dict[str, HunkEvidence]:
    if parsed is None:
        return {}
    f2p = proof.frozen_manifest.f2p if proof else []
    findings = [f for c in checks for f in live_findings(c)]
    out: dict[str, HunkEvidence] = {}
    for fc in parsed.files:
        if fc.is_test:
            tests = [t for t in f2p if t.split("::")[0] == fc.path] or [fc.path]
        else:
            tests = list(f2p) or (related_test_files(root, [fc.path]) if root else [])
        for h in fc.hunks:
            outcomes = _outcomes(proof, tests)
            if not outcomes:
                result = "untested"
            elif all(o == "passed" for o in outcomes):
                result = "pass"
            else:
                result = "fail"
            out[h.hunk_id] = HunkEvidence(
                tests=tests,
                result=result,
                findings=[
                    f.id
                    for f in findings
                    if f.file == fc.path and _overlaps(h, f.line_start, f.line_end)
                ],
            )
    return out
