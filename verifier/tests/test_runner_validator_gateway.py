from __future__ import annotations

import asyncio

import pytest

from pcp_verifier.contracts import CheckResult, Finding, LLMMessage, LLMRequest, PatchContext
from pcp_verifier.core.runner import run_checkers
from pcp_verifier.gateway import FakeProvider, Gateway, GatewayError
from pcp_verifier.validator import band, citation_ok, validate

CTX = PatchContext(
    patch_id="p",
    attempt=1,
    task="t",
    repo_root=".",
    shadow_root=".",
    diff="x",
    changed_files=[],
    hunks=[],
)


def ok(name):
    async def run(_ctx):
        return CheckResult(checker=name, risk_modifier=0, status="pass")

    return run


async def test_runner_timeout_and_crash_become_fallbacks():
    async def slow(_ctx):
        await asyncio.sleep(5)

    async def boom(_ctx):
        raise RuntimeError("kaboom")

    checkers = {"proof": ok("proof"), "safety": slow, "coverage": boom, "scope": ok("scope")}
    res = await run_checkers(CTX, checkers, timeout_s=0.2)
    by = {r.checker: r for r in res}
    assert [r.checker for r in res] == ["proof", "safety", "coverage", "scope"]
    assert by["safety"].risk_modifier == 50 and "timed out" in by["safety"].findings[0].message
    assert by["coverage"].status == "warning" and "kaboom" in by["coverage"].findings[0].message
    assert by["proof"].status == "pass"


async def test_runner_rejects_wrong_checker_name():
    checkers = {
        "proof": ok("safety"),
        "safety": ok("safety"),
        "coverage": ok("coverage"),
        "scope": ok("scope"),
    }
    res = await run_checkers(CTX, checkers)
    assert res[0].checker == "proof" and res[0].risk_modifier == 50


# ------------------------------------------------------------------ validator
@pytest.fixture
def repo(tmp_path):
    (tmp_path / "a.py").write_text("x = 1\nresult = eval(data)\ny = 2\n")
    return tmp_path


def llm_finding(**kw):
    base = {
        "id": "s-1",
        "type": "dangerous_call",
        "source": "llm",
        "confidence": 0.95,
        "file": "a.py",
        "line_start": 2,
        "line_end": 2,
        "evidence": "eval(data)",
        "message": "eval",
    }
    return Finding(**(base | kw))


@pytest.mark.parametrize(
    "kw, ok_",
    [
        ({}, True),
        ({"file": "missing.py"}, False),
        ({"line_start": 9, "line_end": 9}, False),
        ({"evidence": "exec(data)"}, False),
        ({"file": "../outside.py"}, False),
        ({"line_start": None, "line_end": None}, False),
    ],
)
def test_citation_check(repo, kw, ok_):
    assert citation_ok(llm_finding(**kw), [repo])[0] is ok_


def test_bands():
    assert [band(x) for x in (0.95, 0.8, 0.6, 0.3)] == ["proven", "plausible", "weak", "dismiss"]


async def test_validate_dismisses_fake_citation_and_merges_confirmed(repo):
    ctx = CTX.model_copy(update={"repo_root": str(repo), "shadow_root": str(repo)})
    check = CheckResult(
        checker="safety",
        risk_modifier=0,
        status="pass",
        findings=[llm_finding(), llm_finding(id="s-2", evidence="not there")],
    )
    gw = Gateway(FakeProvider("judge", reply='{"verdict": "confirm", "confidence": 0.92}'), None)
    (out,), stats = await validate(ctx, [check], gw)
    assert [f.validated for f in out.findings] == ["confirmed", "dismissed"]
    assert stats.dismissed == 1 and out.risk_modifier == 55 and out.status == "warning"


async def test_validate_without_llm_reduces_confidence(repo):
    ctx = CTX.model_copy(update={"repo_root": str(repo), "shadow_root": str(repo)})
    check = CheckResult(
        checker="safety", risk_modifier=0, status="pass", findings=[llm_finding(confidence=0.55)]
    )
    (out,), _ = await validate(ctx, [check], None)
    assert out.findings[0].validated == "dismissed"  # 0.55 * 0.8 < 0.5
    assert out.risk_modifier == 0


async def test_non_llm_findings_untouched():
    f = llm_finding(source="heuristic", file="nope.py", validated="not_required")
    check = CheckResult(checker="safety", risk_modifier=60, status="warning", findings=[f])
    (out,), stats = await validate(CTX, [check], None)
    assert out.findings[0].validated == "not_required" and stats.checked == 0
    assert out.risk_modifier == 60


# ------------------------------------------------------------------ gateway
REQ = LLMRequest(messages=[LLMMessage(role="user", content="hi")], purpose="test")


async def test_gateway_primary_ok():
    r = await Gateway(FakeProvider("p", reply="hello"), FakeProvider("s")).complete(REQ)
    assert (r.text, r.model_used, r.failed_over, r.failover_ms) == ("hello", "primary:p", False, 0)


async def test_gateway_retry_then_primary():
    r = await Gateway(FakeProvider("p", mode="flaky", reply="ok"), FakeProvider("s")).complete(REQ)
    assert r.model_used == "primary:p" and len(r.errors) == 1


async def test_gateway_fails_over_and_journals():
    log = []
    primary, secondary = FakeProvider("p", mode="fail"), FakeProvider("s", reply="backup")
    r = await Gateway(primary, secondary, journal=log.append).complete(REQ)
    assert r.text == "backup" and r.model_used == "secondary:s" and r.failed_over
    assert primary.calls == 2 and r.failover_ms >= 250  # retried once with backoff
    assert [e["attempt"] for e in log] == ["primary", "primary retry", "secondary"]


async def test_gateway_timeout_counts_as_failure():
    gw = Gateway(FakeProvider("p", mode="timeout"), FakeProvider("s", reply="b"), timeout_s=0.1)
    assert (await gw.complete(REQ)).model_used == "secondary:s"


async def test_gateway_all_fail():
    with pytest.raises(GatewayError):
        await Gateway(FakeProvider("p", mode="fail"), FakeProvider("s", mode="fail")).complete(REQ)
