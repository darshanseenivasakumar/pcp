"""Run all checkers in parallel with per-checker timeouts.

A checker that crashes or times out never takes the pipeline down: it becomes
a fallback result (modifier 50, warning) that says what went wrong.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable

from pcp_verifier.checkers import coverage, proof, safety, scope
from pcp_verifier.contracts import CheckResult, Finding, PatchContext

Checker = Callable[[PatchContext], Awaitable[CheckResult]]
CHECKERS: dict[str, Checker] = {
    "proof": proof.run,
    "safety": safety.run,
    "coverage": coverage.run,
    "scope": scope.run,
}
FALLBACK_MODIFIER = 50


def fallback(name: str, why: str) -> CheckResult:
    return CheckResult(
        checker=name,
        risk_modifier=FALLBACK_MODIFIER,
        status="warning",
        findings=[
            Finding(
                id=f"{name}-fallback",
                type="other",
                source="tool",
                confidence=1.0,
                message=f"{name} checker {why}; using fallback result",
            )
        ],
        recommended_action=f"Re-run the {name} checker",
    )


async def run_checkers(
    ctx: PatchContext,
    checkers: dict[str, Checker] | None = None,
    timeout_s: float | None = None,
    on_done: Callable[[CheckResult], None] | None = None,
) -> list[CheckResult]:
    checkers = checkers or CHECKERS
    timeout_s = timeout_s or float(os.environ.get("PCP_CHECKER_TIMEOUT_S", "30"))

    async def one(name: str, fn: Checker) -> CheckResult:
        try:
            res = await asyncio.wait_for(fn(ctx), timeout_s)
            if not isinstance(res, CheckResult) or res.checker != name:
                raise TypeError(f"returned {type(res).__name__} for {name!r}")
            res = CheckResult.model_validate(res.model_dump())  # contract check, loudly
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            res = fallback(name, f"timed out after {timeout_s:.0f}s")
        except Exception as e:  # noqa: BLE001 - a crashed checker must not crash the pipeline
            res = fallback(name, f"crashed ({type(e).__name__}: {str(e)[:200]})")
        if on_done:
            on_done(res)
        return res

    return list(await asyncio.gather(*(one(n, f) for n, f in checkers.items())))
