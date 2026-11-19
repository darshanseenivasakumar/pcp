"""The whole verification pipeline: proof -> checks -> validate -> verdict.

Used by the HTTP server and by the bench, so both exercise the same code.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from pcp_verifier.checkers import llm_review
from pcp_verifier.checkers.common import current_sandbox
from pcp_verifier.contracts import Event, PatchContext, Proof, Verdict, VerifyRequest
from pcp_verifier.core.diffparse import DiffError, parse_diff
from pcp_verifier.core.evidence import build_hunk_evidence
from pcp_verifier.core.proof_runner import FrozenState, run_proof
from pcp_verifier.core.runner import CHECKERS, fallback, run_checkers
from pcp_verifier.core.sandbox import LocalTempSandbox, SandboxCancelled
from pcp_verifier.core.verdict import build_verdict, compute_score
from pcp_verifier.validator import validate

EmitEvent = Callable[[Event], None]


@dataclass
class ChainState:
    """What a repair attempt inherits from the previous attempt."""

    frozen: FrozenState | None = None
    score_history: list[int] = field(default_factory=list)


@dataclass
class RunHandle:
    """Live state of one verification, so it can be cancelled."""

    patch_id: str
    sandboxes: list[LocalTempSandbox] = field(default_factory=list)
    cancelled: bool = False

    def register(self, sb: LocalTempSandbox) -> None:
        self.sandboxes.append(sb)
        if self.cancelled:
            sb.kill()

    def cancel(self) -> None:
        self.cancelled = True
        for sb in self.sandboxes:
            sb.kill()


@dataclass
class PipelineResult:
    verdict: Verdict
    frozen: FrozenState
    latency_ms: int


def cancelled_verdict(
    patch_id: str, attempt: int, history: list[int], proof: Proof | None = None
) -> Verdict:
    checks = [fallback(n, "was cancelled") for n in CHECKERS]
    score = compute_score(checks)
    return Verdict(
        patch_id=patch_id,
        score=score,
        decision="BLOCK",
        decision_reason="verification was cancelled by the user; nothing was written",
        unproven=False,
        attempt=attempt,
        score_history=[*history, score],
        checks=checks,
        proof=proof,
        summary_md="**Cancelled.** Verification stopped; the sandbox was killed and no files were changed.",
        created_at=_now(),
    )


def _now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


async def verify(
    req: VerifyRequest,
    patch_id: str,
    *,
    chain: ChainState | None = None,
    emit: EmitEvent | None = None,
    handle: RunHandle | None = None,
    gateway=None,
) -> PipelineResult:
    chain = chain or ChainState()
    handle = handle or RunHandle(patch_id)
    emit_ = emit or (lambda _e: None)
    t0 = time.monotonic()

    def ev(stage, status, message, /, **data):
        emit_(Event(patch_id=patch_id, stage=stage, status=status, message=message, data=data))

    if gateway is not None:
        llm_review.set_gateway(gateway)

    if not Path(req.repo_root).is_dir():
        raise FileNotFoundError(f"repo_root does not exist: {req.repo_root}")

    outcome = None
    try:
        # ---- [1] proof
        ev("proof", "started", "Copying repo to shadow folders and applying the patch")
        outcome = await run_proof(
            repo_root=req.repo_root,
            diff=req.diff,
            attempt=req.attempt,
            frozen=chain.frozen,
            emit=lambda m, d: ev("proof", "started", m, **d),
            register=handle.register,
        )
        p = outcome.proof
        if p.apply_ok:
            ev(
                "proof",
                "done",
                f"F2P {'ok' if p.f2p_ok else 'not proven'} ({len(p.frozen_manifest.f2p)} new test(s)), "
                f"P2P {'ok' if p.p2p_ok else 'broken'}; {p.patched.passed} passed, {p.patched.failed} failed"
                + (f"; TAMPERING x{len(p.tampering)}" if p.tampering else ""),
                f2p_ok=p.f2p_ok,
                p2p_ok=p.p2p_ok,
                tampering=len(p.tampering),
            )
        else:
            ev("proof", "failed", f"Proof could not run: {p.error}", error=p.error)

        # ---- [2] checks in parallel
        shadow = outcome.patched_sandbox.work if outcome.patched_sandbox else Path(req.repo_root)
        try:
            parsed = outcome.parsed or parse_diff(req.diff)
            hunks, changed = parsed.hunks, parsed.changed_files
        except DiffError:
            parsed, hunks, changed = None, [], []
        ctx = PatchContext(
            patch_id=patch_id,
            attempt=req.attempt,
            task=req.task,
            repo_root=str(Path(req.repo_root).resolve()),
            shadow_root=str(shadow),
            diff=req.diff,
            changed_files=changed,
            hunks=hunks,
            proof=p,
            approve_big_rewrite=req.approve_big_rewrite,
        )
        ev(
            "checks",
            "started",
            "Running 4 checkers",
            checkers=["proof", "safety", "coverage", "scope"],
        )
        token = current_sandbox.set(outcome.patched_sandbox)
        try:
            checks = await run_checkers(
                ctx,
                on_done=lambda c: ev(
                    "checks",
                    "done",
                    f"{c.checker}: {c.status} ({c.risk_modifier})",
                    checker=c.checker,
                    risk_modifier=c.risk_modifier,
                    status=c.status,
                ),  # fmt: skip
            )
        finally:
            current_sandbox.reset(token)
        if handle.cancelled:
            raise SandboxCancelled("cancelled")

        # ---- [3] validate
        ev("validate", "started", "Checking citations of model findings")
        checks, stats = await validate(ctx, checks, gateway)
        ev(
            "validate",
            "done",
            f"{stats.checked} model finding(s) checked, {stats.dismissed} dismissed",
            checked=stats.checked,
            dismissed=stats.dismissed,
        )

        # ---- [4] verdict (pure math)
        evidence = build_hunk_evidence(parsed, p, checks, shadow)
        verdict = build_verdict(
            patch_id=patch_id,
            attempt=req.attempt,
            checks=checks,
            proof=p,
            hunk_evidence=evidence,
            previous_scores=chain.score_history,
            approve_big_rewrite=req.approve_big_rewrite,
        )
        ev(
            "verdict",
            "done",
            f"{verdict.decision}, score {verdict.score}"
            + (" (unproven)" if verdict.unproven else ""),
            decision=verdict.decision,
            score=verdict.score,
            unproven=verdict.unproven,
        )
        return PipelineResult(verdict, outcome.frozen, int((time.monotonic() - t0) * 1000))
    except (SandboxCancelled, asyncio.CancelledError):
        verdict = cancelled_verdict(patch_id, req.attempt, chain.score_history)
        ev(
            "verdict",
            "failed",
            "Cancelled: sandbox killed, no files changed",
            decision="BLOCK",
            cancelled=True,
        )
        return PipelineResult(
            verdict, chain.frozen or FrozenState(), int((time.monotonic() - t0) * 1000)
        )
    finally:
        if outcome is not None and outcome.patched_sandbox is not None:
            await asyncio.to_thread(outcome.patched_sandbox.cleanup)
