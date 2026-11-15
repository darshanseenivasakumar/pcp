from __future__ import annotations

import pytest
from conftest import tiny_diff

from pcp_verifier.core.proof_runner import run_proof

ON = "tests/test_mathx.py::test_parse_bool_on"


async def prove(repo, name, attempt=1, frozen=None):
    out = await run_proof(repo_root=repo, diff=tiny_diff(name), attempt=attempt, frozen=frozen)
    if out.patched_sandbox:
        out.patched_sandbox.cleanup()
    return out


async def test_good_patch_is_proven(tiny_repo):
    out = await prove(tiny_repo, "good")
    p = out.proof
    assert p.apply_ok and p.f2p_ok and p.p2p_ok and not p.tampering
    assert p.frozen_manifest.f2p == [ON]
    assert p.baseline.tests[f"{ON}[on]"] == "failed"  # new test fails on the old code
    assert p.patched.tests[f"{ON}[on]"] == "passed"  # ... and passes on the new code
    assert p.patched.failed == 0 and p.patched.passed == 16


async def test_fixable_patch_fails_f2p(tiny_repo):
    p = (await prove(tiny_repo, "fixable")).proof
    assert not p.f2p_ok and p.p2p_ok
    assert p.patched.tests[f"{ON}[ON]"] == "failed"


async def test_regression_breaks_p2p(tiny_repo):
    out = await prove(tiny_repo, "regression")
    assert out.proof.f2p_ok and not out.proof.p2p_ok
    assert "tests/test_mathx.py::test_clamp_edges" in out.regressions


async def test_no_test_patch_has_no_f2p(tiny_repo):
    p = (await prove(tiny_repo, "no_test")).proof
    assert p.frozen_manifest.f2p == [] and not p.f2p_ok and p.p2p_ok


async def test_malicious_deletes_existing_test(tiny_repo):
    p = (await prove(tiny_repo, "malicious")).proof
    assert [(t.test_id, t.kind) for t in p.tampering] == [
        ("tests/test_mathx.py::test_clamp_bad_range", "deleted")
    ]


async def test_repair_chain_keeps_frozen_manifest(tiny_repo):
    first = await prove(tiny_repo, "fixable")
    second = await prove(tiny_repo, "fixable_v2", attempt=2, frozen=first.frozen)
    p = second.proof
    assert p.frozen_manifest.f2p == [ON]
    assert p.f2p_ok and p.p2p_ok and not p.tampering


@pytest.mark.parametrize(
    "name, kind",
    [
        ("tamper_skip", "skipped"),
        ("tamper_weaken", "weakened_assert"),
        ("tamper_delete", "deleted"),
    ],
)
async def test_tampering_on_later_attempt(tiny_repo, name, kind):
    first = await prove(tiny_repo, "fixable")
    p = (await prove(tiny_repo, name, attempt=2, frozen=first.frozen)).proof
    assert [(t.test_id, t.kind) for t in p.tampering] == [(ON, kind)]
    assert not p.f2p_ok


async def test_unappliable_diff(tiny_repo):
    bad = tiny_diff("good").replace('TRUE_VALUES = {"1", "true", "yes"}', "NOPE = 1")
    out = await run_proof(repo_root=tiny_repo, diff=bad)
    assert not out.proof.apply_ok and "git apply failed" in out.proof.error
    assert out.patched_sandbox is None


async def test_original_repo_untouched(tiny_repo):
    before = {p: p.read_bytes() for p in tiny_repo.rglob("*") if p.is_file()}
    await prove(tiny_repo, "good")
    after = {p: p.read_bytes() for p in tiny_repo.rglob("*") if p.is_file()}
    assert before == after
