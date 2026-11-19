"""Safety checker: regex first, then optional tools (gitleaks/semgrep), then optional LLM.

Final risk = max() over all layers, so a later layer can never hide an
earlier one. A secret short-circuits straight to critical with no LLM call.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

from pcp_verifier.checkers import llm_review
from pcp_verifier.checkers.common import ResultBuilder, mask, parsed
from pcp_verifier.checkers.safety_rules import GUARD_START, SECRET_MODIFIER, scan_line
from pcp_verifier.contracts import CheckResult, PatchContext

NAME = "safety"
M_REMOVED_GUARD = 40
TOOL_TIMEOUT_S = 20


def _heuristics(ctx: PatchContext, r: ResultBuilder) -> bool:
    """Returns True if a secret was found."""
    found_secret = False
    for fc in parsed(ctx).files:
        is_py = fc.path.endswith(".py")
        for line_no, text in fc.added:
            for rule, m in scan_line(text, is_py, fc.is_test):
                is_secret = rule.kind == "secret"
                found_secret |= is_secret
                evidence = text.replace(m.group(0), mask(m.group(0))) if is_secret else text.strip()
                r.add(
                    rule.modifier,
                    critical=is_secret,
                    type=rule.kind,
                    source="heuristic",
                    confidence=0.95 if is_secret else 0.7,
                    file=fc.path,
                    line_start=line_no,
                    line_end=line_no,
                    evidence=evidence.strip()[:200],
                    message=f"{rule.message} ({rule.id})",
                    action="Remove the secret and rotate it" if is_secret else f"Avoid {rule.id}",
                )
        if is_py:
            removed_guards = [(n, t) for n, t in fc.removed if GUARD_START.match(t)]
            added_guards = [t for _, t in fc.added if GUARD_START.match(t)]
            if len(removed_guards) > len(added_guards):
                n, t = removed_guards[0]
                r.add(
                    M_REMOVED_GUARD,
                    type="removed_guard",
                    source="heuristic",
                    confidence=0.6,
                    file=fc.path,
                    line_start=n,
                    line_end=n,
                    evidence=t.strip(),
                    message="Error handling (try/except) was removed",
                    action="Keep the error handling or explain why it is safe to drop",
                )
    return found_secret


def _semgrep(ctx: PatchContext, r: ResultBuilder) -> None:
    """Optional: semgrep on the changed files in the patched shadow, changed lines only."""
    exe = shutil.which("semgrep")
    if not exe or os.environ.get("PCP_SEMGREP", "1") == "0":
        return
    p = parsed(ctx)
    added = {f.path: {n for n, _ in f.added} for f in p.files if f.path.endswith(".py")}
    targets = [
        str(Path(ctx.shadow_root) / f) for f in added if (Path(ctx.shadow_root) / f).is_file()
    ]
    if not targets:
        return
    try:
        out = subprocess.run(
            [exe, "--config", "p/python", "--json", "--quiet", "--metrics=off", *targets],
            capture_output=True,
            text=True,
            timeout=TOOL_TIMEOUT_S,
        )
        results = json.loads(out.stdout or "{}").get("results", [])
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return
    for res in results:
        rel = Path(res["path"]).resolve().relative_to(Path(ctx.shadow_root).resolve()).as_posix()
        line = res["start"]["line"]
        if line not in added.get(rel, set()):
            continue
        sev = res.get("extra", {}).get("severity", "WARNING")
        r.add(
            60 if sev == "ERROR" else 30,
            type="dangerous_call",
            source="tool",
            confidence=0.7,
            file=rel,
            line_start=line,
            line_end=res["end"]["line"],
            evidence=res.get("extra", {}).get("lines", "")[:200],
            message=f"semgrep {res.get('check_id', '')}: {res.get('extra', {}).get('message', '')[:200]}",
        )


async def run(ctx: PatchContext) -> CheckResult:
    r = ResultBuilder(NAME)
    if _heuristics(ctx, r):
        r.bump(SECRET_MODIFIER, critical=True)
        return r.build()  # secret: short-circuit, no tools, no LLM
    await asyncio.to_thread(_semgrep, ctx, r)
    # LLM findings carry no risk yet: the validator confirms them, then merges with max()
    for f, _mod in await llm_review.review(ctx, NAME):
        r.findings.append(f.model_copy(update={"id": f"{NAME}-{len(r.findings) + 1}"}))
    return r.build()
