from __future__ import annotations

import pytest
from conftest import load_example

from pcp_verifier.contracts import CheckResult, Finding, Proof, Verdict
from pcp_verifier.core.verdict import build_verdict, compute_score, decide


def chk(name, mod=0, status="pass", findings=()):
    return CheckResult(checker=name, risk_modifier=mod, status=status, findings=list(findings))


def clean(**over):
    base = {n: chk(n) for n in ("proof", "safety", "coverage", "scope")}
    base.update(over)
    return list(base.values())


BIG = Finding(
    id="b1", type="big_rewrite", source="heuristic", confidence=1.0, message="80% rewrite"
)


# ------------------------------------------------------------------ score math
def test_score_all_clean_is_100():
    assert compute_score(clean()) == 100


def test_score_weights():
    # 100 - (100*.35 + 100*.25 + 100*.2 + 100*.2) = 0
    assert (
        compute_score([chk(n, 100, "warning") for n in ("proof", "safety", "coverage", "scope")])
        == 0
    )
    assert compute_score(clean(proof=chk("proof", 100, "warning"))) == 65
    assert compute_score(clean(safety=chk("safety", 90, "critical"))) == 78  # 77.5 rounds half-up


def test_score_requires_all_four_checkers():
    with pytest.raises(ValueError, match="one result per checker"):
        compute_score(clean()[:3])
    with pytest.raises(ValueError):
        compute_score([*clean(), chk("proof")])


@pytest.mark.parametrize(
    "name",
    [
        "verdict_review.json",
        "verdict_repair.json",
        "verdict_block.json",
        "verdict_review_unproven.json",
    ],
)
def test_examples_match_score_formula(name):
    v = Verdict.model_validate(load_example(name))
    assert compute_score(v.checks) == v.score


# ------------------------------------------------------------------ routing edges
@pytest.mark.parametrize(
    "score, attempt, expected",
    [
        (100, 1, "REVIEW"),
        (70, 1, "REVIEW"),
        (69, 1, "REPAIR"),
        (40, 1, "REPAIR"),
        (39, 1, "BLOCK"),
        (0, 1, "BLOCK"),
        (69, 2, "REPAIR"),
        (69, 3, "BLOCK"),  # repair budget used up
        (70, 3, "REVIEW"),  # a good score on the last attempt is still reviewable
    ],
)
def test_decide_edges(score, attempt, expected):
    decision, reason = decide(score, clean(), attempt)
    assert decision == expected
    assert reason.strip()


def test_critical_blocks_even_at_100():
    checks = clean(safety=chk("safety", 90, "critical"))
    decision, reason = decide(100, checks, 1)
    assert decision == "BLOCK"
    assert "safety" in reason


def test_big_rewrite_needs_approval():
    checks = clean(scope=chk("scope", 30, "warning", [BIG]))
    assert decide(94, checks, 1)[0] == "BLOCK"
    assert decide(94, checks, 1, approve_big_rewrite=True)[0] == "REVIEW"


def test_dismissed_big_rewrite_does_not_block():
    checks = clean(
        scope=chk("scope", 0, "pass", [BIG.model_copy(update={"validated": "dismissed"})])
    )
    assert decide(100, checks, 1)[0] == "REVIEW"


# ------------------------------------------------------------------ build_verdict
def _proof(ok=True):
    return Proof.model_validate(load_example("proof.json")).model_copy(update={"f2p_ok": ok})


def test_build_verdict_review_proven():
    v = build_verdict(patch_id="p", attempt=1, checks=clean(), proof=_proof())
    assert (v.decision, v.score, v.unproven, v.repair_instructions) == ("REVIEW", 100, False, None)


def test_build_verdict_review_unproven_when_no_f2p():
    v = build_verdict(
        patch_id="p",
        attempt=1,
        checks=clean(proof=chk("proof", 40, "warning")),
        proof=_proof(False),
    )
    assert v.decision == "REVIEW" and v.unproven


def test_build_verdict_repair_has_instructions_and_history():
    checks = clean(proof=chk("proof", 90, "warning"))
    v = build_verdict(
        patch_id="p", attempt=1, checks=checks, proof=_proof(False), previous_scores=[]
    )
    assert v.decision == "REPAIR"
    assert "attempt 2 of 3" in v.repair_instructions
    assert "Do NOT edit" in v.repair_instructions
    v2 = build_verdict(
        patch_id="q", attempt=2, checks=clean(), proof=_proof(), previous_scores=[v.score]
    )
    assert v2.score_history == [v.score, 100]
