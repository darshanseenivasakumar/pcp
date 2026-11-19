"""Optional LLM layer for checkers (PCP_LLM_CHECKS=1 and a configured gateway).

The model only *proposes* findings (source="llm"). They carry no risk until
the validator has checked their citations and confirmed them; the validator
then merges their risk with max(). Any failure here returns no findings.
"""

from __future__ import annotations

import json
import os
import re

from pcp_verifier.contracts import Finding, LLMMessage, LLMRequest, PatchContext

LLM_MAX_MODIFIER = 60  # an LLM alone can raise a warning, never a critical
_gateway = None


def set_gateway(gw) -> None:
    global _gateway
    _gateway = gw


def get_gateway():
    return _gateway


def llm_modifier(confidence: float) -> int:
    return round(LLM_MAX_MODIFIER * confidence)


PROMPT = """You review a code patch for the {checker} checker of a verification tool.
Task given to the coding agent: {task}

Report only concrete, real problems in ADDED lines. Reply with JSON only:
{{"findings": [{{"type": "dangerous_call|removed_guard|out_of_scope|missing_test|other",
  "file": "path", "line_start": N, "line_end": N, "evidence": "exact text copied from the line",
  "message": "plain English", "confidence": 0.0-1.0}}]}}
Reply {{"findings": []}} if nothing is wrong.

Patch:
{diff}"""

ALLOWED_TYPES = {"dangerous_call", "removed_guard", "out_of_scope", "missing_test", "other"}


def _extract_json(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0)) if m else {}


async def review(ctx: PatchContext, checker: str) -> list[tuple[Finding, int]]:
    gw = _gateway
    if gw is None or os.environ.get("PCP_LLM_CHECKS", "0") != "1":
        return []
    req = LLMRequest(
        purpose=f"checker:{checker}",
        messages=[
            LLMMessage(
                role="system", content="You are a strict, precise code reviewer. JSON only."
            ),
            LLMMessage(
                role="user",
                content=PROMPT.format(checker=checker, task=ctx.task, diff=ctx.diff[:12000]),
            ),
        ],
        max_tokens=800,
    )
    try:
        resp = await gw.complete(req)
        raw = _extract_json(resp.text).get("findings", [])
    except Exception:  # noqa: BLE001 - the LLM layer is optional; never crash a checker
        return []
    out = []
    for i, item in enumerate(raw[:10]):
        try:
            conf = max(0.0, min(1.0, float(item.get("confidence", 0.5))))
            f = Finding(
                id=f"llm-{i + 1}",
                type=item.get("type") if item.get("type") in ALLOWED_TYPES else "other",
                source="llm",
                confidence=conf,
                file=item.get("file"),
                line_start=int(item["line_start"]) if item.get("line_start") is not None else None,
                line_end=int(item.get("line_end") or item.get("line_start") or 0) or None,
                evidence=str(item.get("evidence", ""))[:300],
                message=str(item.get("message", "LLM finding"))[:500],
            )
        except (ValueError, TypeError):
            continue
        out.append((f, llm_modifier(conf)))
    return out
