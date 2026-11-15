"""PCP shared message contracts (source of truth).

Both sides depend on these shapes. Change them only in a contracts-only PR that
updates this file, `schemas/` (run `python contracts/gen_schemas.py`),
`types.ts` and `examples/` together.

Every model forbids unknown fields, so a mismatch fails loudly (AGENTS.md rule 5).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACTS_VERSION = "0.1.0"

CheckerName = Literal["proof", "safety", "coverage", "scope"]
CheckStatus = Literal["pass", "warning", "critical"]
FindingType = Literal[
    "test_failure",
    "missing_test",
    "tampering",
    "secret",
    "dangerous_call",
    "removed_guard",
    "out_of_scope",
    "big_rewrite",
    "other",
]
FindingSource = Literal["heuristic", "tool", "test_output", "llm"]
Validated = Literal["confirmed", "dismissed", "not_required"]
Decision = Literal["REVIEW", "REPAIR", "BLOCK"]
Stage = Literal["proof", "checks", "validate", "verdict"]
EventStatus = Literal["started", "done", "failed"]
TestOutcome = Literal["passed", "failed", "skipped", "error"]
TamperKind = Literal["deleted", "skipped", "weakened_assert", "renamed"]
HunkResult = Literal["pass", "fail", "untested"]

REVIEW_THRESHOLD = 70
REPAIR_THRESHOLD = 40
MAX_ATTEMPTS = 3


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- patch shape
class Hunk(_Strict):
    hunk_id: str
    file: str
    old_start: int = Field(ge=0)
    old_lines: int = Field(ge=0)
    new_start: int = Field(ge=0)
    new_lines: int = Field(ge=0)


# ---------------------------------------------------------------- proof
class RunResult(_Strict):
    exit_code: int
    passed: int = Field(ge=0)
    failed: int = Field(ge=0)
    skipped: int = Field(default=0, ge=0)
    errors: int = Field(default=0, ge=0)
    duration_s: float = Field(ge=0)
    # node id -> outcome, parsed by the host from junit XML (never model-reported)
    tests: dict[str, TestOutcome] = Field(default_factory=dict)
    output_tail: str = ""


class FrozenManifest(_Strict):
    f2p: list[str] = Field(default_factory=list)
    p2p: list[str] = Field(default_factory=list)


class TamperEvent(_Strict):
    test_id: str
    kind: TamperKind
    detail: str


class Proof(_Strict):
    attempt: int = Field(ge=1)
    sandbox: str
    frozen_manifest: FrozenManifest
    baseline: RunResult | None = None
    patched: RunResult | None = None
    f2p_ok: bool
    p2p_ok: bool
    tampering: list[TamperEvent] = Field(default_factory=list)
    apply_ok: bool = True
    error: str | None = None


# ---------------------------------------------------------------- checks
class Finding(_Strict):
    id: str
    type: FindingType
    source: FindingSource
    confidence: float = Field(ge=0.0, le=1.0)
    file: str | None = None
    line_start: int | None = Field(default=None, ge=0)
    line_end: int | None = Field(default=None, ge=0)
    evidence: str = ""
    message: str
    validated: Validated = "not_required"

    @model_validator(mode="after")
    def _line_range(self) -> Finding:
        if (
            self.line_start is not None
            and self.line_end is not None
            and self.line_end < self.line_start
        ):
            raise ValueError("line_end must be >= line_start")
        return self


class CheckResult(_Strict):
    checker: CheckerName
    risk_modifier: int = Field(ge=0, le=100)
    status: CheckStatus
    findings: list[Finding] = Field(default_factory=list)
    recommended_action: str = ""


class PatchContext(_Strict):
    patch_id: str
    attempt: int = Field(ge=1)
    task: str
    repo_root: str
    shadow_root: str
    diff: str
    changed_files: list[str]
    hunks: list[Hunk]
    proof: Proof | None = None
    approve_big_rewrite: bool = False


# ---------------------------------------------------------------- verdict
class HunkEvidence(_Strict):
    tests: list[str] = Field(default_factory=list)
    result: HunkResult = "untested"
    findings: list[str] = Field(default_factory=list)


def _live(findings: list[Finding]) -> list[Finding]:
    return [f for f in findings if f.validated != "dismissed"]


class Verdict(_Strict):
    patch_id: str
    score: int = Field(ge=0, le=100)
    decision: Decision
    decision_reason: str
    unproven: bool
    attempt: int = Field(ge=1)
    score_history: list[int] = Field(min_length=1)
    checks: list[CheckResult]
    proof: Proof | None = None
    hunk_evidence: dict[str, HunkEvidence] = Field(default_factory=dict)
    repair_instructions: str | None = None
    summary_md: str
    big_rewrite_approved: bool = False
    created_at: str

    @model_validator(mode="after")
    def _invariants(self) -> Verdict:
        any_critical = any(c.status == "critical" for c in self.checks)
        if any_critical and self.decision != "BLOCK":
            raise ValueError("invariant: a critical check forces BLOCK")
        if self.score < REVIEW_THRESHOLD and self.decision == "REVIEW":
            raise ValueError("invariant: score < 70 can never be REVIEW")
        big_rewrite = any(
            f.type == "big_rewrite" for c in self.checks for f in _live(c.findings)
        )
        if big_rewrite and not self.big_rewrite_approved and self.decision != "BLOCK":
            raise ValueError(
                "invariant: an unapproved big_rewrite goes to a human (BLOCK)"
            )
        if self.decision == "REPAIR" and not (self.repair_instructions or "").strip():
            raise ValueError("invariant: REPAIR needs repair_instructions")
        proven = self.proof is not None and self.proof.f2p_ok and self.proof.p2p_ok
        if self.decision == "REVIEW" and not proven and not self.unproven:
            raise ValueError(
                "invariant: REVIEW without a passing proof must be unproven"
            )
        if self.score_history[-1] != self.score:
            raise ValueError("invariant: score_history must end with score")
        return self


# ---------------------------------------------------------------- streaming
class Event(_Strict):
    patch_id: str
    stage: Stage
    status: EventStatus
    message: str
    data: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------- HTTP API
class VerifyRequest(_Strict):
    task: str = Field(min_length=1)
    repo_root: str = Field(min_length=1)
    diff: str = Field(min_length=1)
    attempt: int = Field(default=1, ge=1)
    previous_patch_id: str | None = None
    approve_big_rewrite: bool = False


class VerifyResponse(_Strict):
    patch_id: str


class LLMMessage(_Strict):
    role: Literal["system", "user", "assistant"]
    content: str


class LLMRequest(_Strict):
    messages: list[LLMMessage] = Field(min_length=1)
    purpose: str
    max_tokens: int | None = Field(default=None, ge=1)


class LLMResponse(_Strict):
    text: str
    model_used: str
    failover_ms: int = Field(ge=0)
    failed_over: bool = False
    errors: list[str] = Field(default_factory=list)


class Health(_Strict):
    status: Literal["ok"]
    version: str
    sandbox: str


# Model registry: schema file name -> model. Example files are matched by
# longest name prefix (e.g. `verdict_block.json` -> Verdict).
MODELS: dict[str, type[BaseModel]] = {
    "hunk": Hunk,
    "run_result": RunResult,
    "proof": Proof,
    "finding": Finding,
    "check_result": CheckResult,
    "patch_context": PatchContext,
    "hunk_evidence": HunkEvidence,
    "verdict": Verdict,
    "event": Event,
    "verify_request": VerifyRequest,
    "verify_response": VerifyResponse,
    "llm_request": LLMRequest,
    "llm_response": LLMResponse,
    "health": Health,
}


def model_for_example(filename: str) -> type[BaseModel]:
    stem = filename.removesuffix(".json")
    matches = [k for k in MODELS if stem == k or stem.startswith((k + "_", k + "s_"))]
    if not matches:
        raise KeyError(f"no contract model for example {filename!r}")
    return MODELS[max(matches, key=len)]
