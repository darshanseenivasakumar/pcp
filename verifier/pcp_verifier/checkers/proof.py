"""Proof checker: turns the host-run proof into risk. No model involved."""

from __future__ import annotations

from pcp_verifier.checkers.common import ResultBuilder, parsed
from pcp_verifier.contracts import CheckResult, PatchContext
from pcp_verifier.core.proof_runner import classify
from pcp_verifier.core.testscan import function_id

NAME = "proof"

M_NO_PROOF = 100  # patch did not apply / tests could not run
M_REGRESSION = 100  # an existing passing test now fails
M_F2P_FAILS = 90  # the new tests still fail on the patched code
M_VACUOUS = 60  # the new tests already pass on the old code: they prove nothing
M_MISSING_TEST = 40  # behaviour changed, no fail-to-pass test
M_TAMPER = 95  # deleted / skipped / weakened protected test -> critical
M_RENAMED = 30


async def run(ctx: PatchContext) -> CheckResult:
    r = ResultBuilder(NAME)
    proof = ctx.proof
    if proof is None or not proof.apply_ok:
        r.add(
            M_NO_PROOF,
            type="test_failure",
            source="tool",
            confidence=1.0,
            message=f"No proof: {proof.error if proof else 'proof runner did not run'}",
            action="Produce a diff that applies cleanly to the original files",
        )
        return r.build()

    base, patched = proof.baseline, proof.patched
    tail = (patched.output_tail if patched else "")[-400:]

    for t in proof.tampering:
        crit = t.kind != "renamed"
        r.add(
            M_TAMPER if crit else M_RENAMED,
            critical=crit,
            type="tampering",
            source="heuristic",
            confidence=1.0,
            file=t.test_id.split("::")[0],
            evidence=t.test_id,
            message=f"Protected test {t.kind}: {t.test_id} ({t.detail})",
            action="Restore the protected tests; never delete, skip or weaken them",
        )

    if patched and patched.exit_code == -1:
        r.add(
            M_NO_PROOF,
            type="test_failure",
            source="test_output",
            confidence=1.0,
            evidence=tail,
            message="Test run timed out on the patched code",
            action="Remove the hang or infinite loop",
        )

    if base and patched:
        _, _, regressions = classify(proof.frozen_manifest.f2p, base, patched)
        if regressions:
            shown = ", ".join(regressions[:5]) + (" …" if len(regressions) > 5 else "")
            r.add(
                M_REGRESSION,
                type="test_failure",
                source="test_output",
                confidence=1.0,
                file=regressions[0].split("::")[0],
                evidence=tail,
                message=f"{len(regressions)} existing test(s) broke: {shown}",
                action="Fix the regression without editing the existing tests",
            )
        collection = [t for t in patched.tests if t.startswith("<collection>")]
        if collection:
            r.add(
                M_NO_PROOF,
                type="test_failure",
                source="test_output",
                confidence=1.0,
                evidence=tail,
                message=f"Tests failed to import/collect: {', '.join(collection[:3])}",
                action="Fix the import or syntax error",
            )

    f2p = proof.frozen_manifest.f2p
    has_source_change = any(not f.is_test for f in parsed(ctx).files)
    if f2p and base and patched and not proof.f2p_ok:
        still_failing = sorted(
            {
                function_id(t)
                for t, o in patched.tests.items()
                if function_id(t) in f2p and o != "passed"
            }
        )
        missing = [fid for fid in f2p if not any(function_id(t) == fid for t in patched.tests)]
        vacuous = [
            fid
            for fid in f2p
            if (cases := [o for t, o in base.tests.items() if function_id(t) == fid])
            and all(o == "passed" for o in cases)
        ]
        if still_failing or missing:
            bad = still_failing + missing
            r.add(
                M_F2P_FAILS,
                type="test_failure",
                source="test_output",
                confidence=1.0,
                file=bad[0].split("::")[0],
                evidence=tail,
                message=f"New test(s) do not pass on the patched code: {', '.join(bad[:5])}",
                action="Make the implementation satisfy the new tests",
            )
        elif vacuous:
            r.add(
                M_VACUOUS,
                type="missing_test",
                source="test_output",
                confidence=0.9,
                file=vacuous[0].split("::")[0],
                message=f"New test(s) already pass on the old code, so they prove nothing: {', '.join(vacuous[:5])}",
                action="Add a test that fails before the change and passes after",
            )
    elif not f2p and has_source_change:
        src = next(f for f in parsed(ctx).files if not f.is_test)
        first = src.added[0][0] if src.added else (src.removed[0][0] if src.removed else None)
        r.add(
            M_MISSING_TEST,
            type="missing_test",
            source="heuristic",
            confidence=0.8,
            file=src.path,
            line_start=first,
            line_end=first,
            message="Behaviour changed but no fail-to-pass test was added",
            action="Add a test that fails on the old code and passes on the new code",
        )
    return r.build()
