"""Deterministic verdict: plain math turns CheckResults into a score and a decision.

No LLM is involved anywhere in this module (AGENTS.md rule 2).
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

from pcp_verifier.contracts import (
    MAX_ATTEMPTS,
    REPAIR_THRESHOLD,
    REVIEW_THRESHOLD,
    CheckResult,
    Finding,
    HunkEvidence,
    Proof,
    Verdict,
)

WEIGHTS: dict[str, float] = {"proof": 0.35, "safety": 0.25, "coverage": 0.20, "scope": 0.20}
REPAIR_OUTPUT_CHARS = 2000


def live_findings(check: CheckResult) -> list[Finding]:
    """Findings that still count: the validator has not dismissed them."""
    return [f for f in check.findings if f.validated != "dismissed"]


def compute_score(checks: list[CheckResult]) -> int:
    """score = clamp(100 - sum(modifier_i * weight_i), 0, 100), rounded half-up.

    All four checkers must be present exactly once: a missing checker would
    silently count as zero risk, so it fails loudly instead.
    """
    names = [c.checker for c in checks]
    if sorted(names) != sorted(WEIGHTS):
        raise ValueError(f"expected one result per checker {sorted(WEIGHTS)}, got {names}")
    penalty = sum(c.risk_modifier * WEIGHTS[c.checker] for c in checks)
    raw = 100.0 - penalty
    return max(0, min(100, math.floor(raw + 0.5)))


def has_critical(checks: list[CheckResult]) -> bool:
    return any(c.status == "critical" for c in checks)


def has_big_rewrite(checks: list[CheckResult]) -> bool:
    return any(f.type == "big_rewrite" for c in checks for f in live_findings(c))


def decide(
    score: int,
    checks: list[CheckResult],
    attempt: int,
    approve_big_rewrite: bool = False,
) -> tuple[str, str]:
    """Return (decision, plain-English reason).

    Rules (AGENTS.md section 3):
        BLOCK  if any critical or big_rewrite unapproved
        REVIEW if score >= 70
        REPAIR if 40 <= score < 70 and attempt < 3
        BLOCK  otherwise
    """
    critical = [c.checker for c in checks if c.status == "critical"]
    if critical:
        return "BLOCK", f"critical issue from {', '.join(critical)}; a human must decide"
    if has_big_rewrite(checks) and not approve_big_rewrite:
        return "BLOCK", "patch rewrites more than 50% of a file; a human must approve it"
    if score >= REVIEW_THRESHOLD:
        return "REVIEW", f"score {score} >= {REVIEW_THRESHOLD}"
    if score >= REPAIR_THRESHOLD:
        if attempt < MAX_ATTEMPTS:
            return "REPAIR", (
                f"score {score} is in the repair band ({REPAIR_THRESHOLD}-{REVIEW_THRESHOLD - 1}), "
                f"attempt {attempt} of {MAX_ATTEMPTS}"
            )
        return "BLOCK", f"score {score} after {attempt} attempts; repair budget used up"
    return "BLOCK", f"score {score} < {REPAIR_THRESHOLD}"


def is_proven(proof: Proof | None) -> bool:
    return proof is not None and proof.apply_ok and proof.f2p_ok and proof.p2p_ok


def repair_instructions(checks: list[CheckResult], proof: Proof | None, attempt: int) -> str:
    """What the agent must fix, worst checker first, plus trimmed test output."""
    lines = [
        f"Fix these and resubmit (attempt {attempt + 1} of {MAX_ATTEMPTS}). "
        "Do NOT edit, skip or weaken the frozen tests."
    ]
    if proof and proof.frozen_manifest.f2p:
        lines.append("Frozen tests: " + ", ".join(proof.frozen_manifest.f2p[:10]))
    lines.append("")
    n = 0
    for c in sorted(checks, key=lambda c: -c.risk_modifier):
        if c.status == "pass":
            continue
        findings = live_findings(c)
        if not findings:
            n += 1
            lines.append(f"{n}. [{c.checker}] risk {c.risk_modifier}: {c.recommended_action}")
        for f in findings:
            n += 1
            where = f" {f.file}:{f.line_start}" if f.file and f.line_start else ""
            lines.append(f"{n}. [{c.checker}]{where} {f.message}")
    if proof and proof.patched and proof.patched.output_tail:
        tail = proof.patched.output_tail[-REPAIR_OUTPUT_CHARS:]
        lines += ["", "Test output (patched, trimmed):", tail]
    elif proof and proof.error:
        lines += ["", f"Proof error: {proof.error}"]
    return "\n".join(lines)


def summary_md(decision: str, score: int, reason: str, unproven: bool, checks, proof) -> str:
    head = {
        "REVIEW": "unproven, review carefully" if unproven else "ready for review",
        "REPAIR": "sent back for repair",
        "BLOCK": "blocked, a human decides",
    }[decision]
    out = [f"**Score {score}: {head}.** {reason}."]
    if proof and proof.baseline and proof.patched:
        f2p = len(proof.frozen_manifest.f2p)
        out.append(
            f"Proof: {f2p} new test(s) {'fail on old code and pass on new' if proof.f2p_ok else 'did not prove the change'}; "
            f"existing tests {'still pass' if proof.p2p_ok else 'broke'} "
            f"({proof.patched.passed} passed, {proof.patched.failed} failed)."
        )
    elif proof and proof.error:
        out.append(f"Proof could not run: {proof.error}")
    bullets = [
        f"- **{c.checker}** ({c.status}, {c.risk_modifier}): {f.message}"
        for c in checks
        for f in live_findings(c)
    ]
    if bullets:
        out += ["", *bullets]
    return "\n".join(out)


def build_verdict(
    *,
    patch_id: str,
    attempt: int,
    checks: list[CheckResult],
    proof: Proof | None,
    hunk_evidence: dict[str, HunkEvidence] | None = None,
    previous_scores: list[int] | None = None,
    approve_big_rewrite: bool = False,
    now: datetime | None = None,
) -> Verdict:
    score = compute_score(checks)
    decision, reason = decide(score, checks, attempt, approve_big_rewrite)
    unproven = decision == "REVIEW" and not is_proven(proof)
    return Verdict(
        patch_id=patch_id,
        score=score,
        decision=decision,
        decision_reason=reason,
        unproven=unproven,
        attempt=attempt,
        score_history=[*(previous_scores or []), score],
        checks=checks,
        proof=proof,
        hunk_evidence=hunk_evidence or {},
        repair_instructions=repair_instructions(checks, proof, attempt)
        if decision == "REPAIR"
        else None,
        summary_md=summary_md(decision, score, reason, unproven, checks, proof),
        big_rewrite_approved=approve_big_rewrite,
        created_at=(now or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
    )


__all__ = [
    "MAX_ATTEMPTS",
    "REPAIR_THRESHOLD",
    "REVIEW_THRESHOLD",
    "WEIGHTS",
    "build_verdict",
    "compute_score",
    "decide",
    "has_big_rewrite",
    "has_critical",
    "is_proven",
    "live_findings",
]
