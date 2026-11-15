"""Validator: never trust a model's citation.

1. Host-side citation check for every `source: llm` finding: the cited file
   exists, the lines are in range, and the evidence snippet is really there.
   Any failure -> dismissed (AGENTS.md rule 4).
2. A read-only LLM confirm/dismiss pass, using codebreaker's bands:
   >=0.9 proven, 0.7-0.9 plausible, 0.5-0.7 weak, <0.5 dismiss.
3. Surviving LLM findings are merged into their check's risk with max().
Findings from heuristics/tools/test output are already grounded: not_required.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from pcp_verifier.checkers.llm_review import llm_modifier
from pcp_verifier.contracts import CheckResult, Finding, LLMMessage, LLMRequest, PatchContext

DISMISS_BELOW = 0.5
UNAVAILABLE_FACTOR = 0.8
CONTEXT_LINES = 3


def band(confidence: float) -> str:
    if confidence >= 0.9:
        return "proven"
    if confidence >= 0.7:
        return "plausible"
    if confidence >= 0.5:
        return "weak"
    return "dismiss"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


@dataclass
class Stats:
    checked: int = 0
    dismissed: int = 0
    confirmed: int = 0


def citation_ok(f: Finding, roots: list[Path]) -> tuple[bool, str, list[str]]:
    """Return (ok, reason, cited_lines)."""
    if not f.file:
        return False, "no file cited", []
    for root in roots:
        path = (root / f.file).resolve()
        try:
            path.relative_to(root.resolve())
        except ValueError:
            return False, "path escapes the repo", []
        if not path.is_file():
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if f.line_start is None:
            return False, "no line cited", []
        start, end = f.line_start, f.line_end or f.line_start
        if start < 1 or end > len(lines):
            return False, f"lines {start}-{end} out of range (file has {len(lines)})", []
        cited = lines[start - 1 : end]
        if f.evidence and _norm(f.evidence) not in _norm("\n".join(cited)):
            return False, "evidence snippet not found at the cited lines", cited
        return True, "ok", cited
    return False, f"file {f.file} does not exist", []


async def _llm_confirm(gateway, ctx: PatchContext, f: Finding, cited: list[str]) -> float | None:
    if gateway is None:
        return None
    prompt = (
        f"Task: {ctx.task}\nA reviewer claims this about {f.file}:{f.line_start}-{f.line_end}:\n"
        f"{f.message}\n\nThe cited code:\n```\n" + "\n".join(cited) + "\n```\n"
        'Is the claim correct? Reply JSON only: {"verdict": "confirm"|"dismiss", "confidence": 0.0-1.0}'
    )
    req = LLMRequest(
        purpose="validator",
        messages=[
            LLMMessage(
                role="system",
                content="You verify code review claims. You cannot edit code. JSON only.",
            ),
            LLMMessage(role="user", content=prompt),
        ],
        max_tokens=100,
    )
    try:
        resp = await gateway.complete(req)
        m = re.search(r"\{.*\}", resp.text, re.S)
        data = json.loads(m.group(0)) if m else {}
        conf = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
        return conf if data.get("verdict") == "confirm" else min(conf, 1 - conf)
    except Exception:  # noqa: BLE001 - validator LLM is optional
        return None


async def validate(
    ctx: PatchContext, checks: list[CheckResult], gateway=None
) -> tuple[list[CheckResult], Stats]:
    roots = [Path(ctx.shadow_root), Path(ctx.repo_root)]
    stats = Stats()
    out: list[CheckResult] = []
    for check in checks:
        findings: list[Finding] = []
        modifier = check.risk_modifier
        for f in check.findings:
            if f.source != "llm":
                findings.append(f)  # grounded by construction (diff, tool or test output)
                continue
            stats.checked += 1
            ok, reason, cited = citation_ok(f, roots)
            if not ok:
                stats.dismissed += 1
                findings.append(
                    f.model_copy(
                        update={
                            "validated": "dismissed",
                            "message": f"{f.message} [dismissed: {reason}]",
                        }
                    )
                )
                continue
            conf = await _llm_confirm(gateway, ctx, f, cited)
            note = ""
            if conf is None:
                conf, note = (
                    f.confidence * UNAVAILABLE_FACTOR,
                    " [validator LLM unavailable; confidence reduced]",
                )
            if conf < DISMISS_BELOW:
                stats.dismissed += 1
                findings.append(
                    f.model_copy(
                        update={
                            "validated": "dismissed",
                            "confidence": conf,
                            "message": f.message + note,
                        }
                    )
                )
                continue
            stats.confirmed += 1
            findings.append(
                f.model_copy(
                    update={
                        "validated": "confirmed",
                        "confidence": conf,
                        "message": f"{f.message} ({band(conf)}){note}",
                    }
                )
            )
            modifier = max(modifier, llm_modifier(conf))
        status = check.status
        if status == "pass" and modifier > 0:
            status = "warning"
        out.append(
            check.model_copy(
                update={"findings": findings, "risk_modifier": modifier, "status": status}
            )
        )
    return out, stats
