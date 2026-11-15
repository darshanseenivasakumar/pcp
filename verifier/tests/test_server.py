from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from conftest import tiny_diff

from pcp_verifier.contracts import Event, Verdict
from pcp_verifier.gateway import FakeProvider, Gateway
from pcp_verifier.journal import Journal
from pcp_verifier.server import create_app

TASK = 'Make parse_bool also treat "on" as true.'


@pytest.fixture
def journal(tmp_path):
    j = Journal(tmp_path / "journal.sqlite")
    yield j
    j.close()


@pytest.fixture
async def client(journal):
    gw = Gateway(
        FakeProvider("primary-fake", mode="fail"),
        FakeProvider("backup-fake", reply="hi"),
        journal=journal.log_llm,
    )
    app = create_app(journal=journal, gateway=gw)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        c.app = app
        yield c


async def wait_verdict(client, patch_id, timeout=90) -> Verdict:
    for _ in range(int(timeout / 0.1)):
        r = await client.get(f"/verify/{patch_id}")
        if r.status_code == 200:
            return Verdict.model_validate(r.json())
        assert r.status_code == 202, r.text
        await asyncio.sleep(0.1)
    raise AssertionError("verdict never arrived")


async def submit(client, repo, name, **kw):
    body = {"task": TASK, "repo_root": str(repo), "diff": tiny_diff(name), **kw}
    r = await client.post("/verify", json=body)
    assert r.status_code == 200, r.text
    return r.json()["patch_id"]


async def test_health(client):
    r = await client.get("/health")
    assert r.json() == {"status": "ok", "version": "0.1.0", "sandbox": "local-temp"}


async def test_good_patch_review_and_events(client, tiny_repo):
    pid = await submit(client, tiny_repo, "good")
    v = await wait_verdict(client, pid)
    assert (v.decision, v.unproven, v.score) == ("REVIEW", False, 100)
    assert v.hunk_evidence["h1"].result == "pass" and v.hunk_evidence["h1"].tests

    r = await client.get(f"/verify/{pid}/events")
    assert r.headers["content-type"].startswith("text/event-stream")
    events = [
        Event.model_validate_json(line[5:].strip())
        for line in r.text.splitlines()
        if line.startswith("data:")
    ]
    stages = [e.stage for e in events]
    assert stages[0] == "proof" and stages[-1] == "verdict"
    assert {"proof", "checks", "validate", "verdict"} <= set(stages)
    assert events[-1].data["decision"] == "REVIEW"


async def test_repair_loop_then_review(client, tiny_repo, journal):
    first = await submit(client, tiny_repo, "fixable")
    v1 = await wait_verdict(client, first)
    assert v1.decision == "REPAIR" and "attempt 2 of 3" in v1.repair_instructions

    second = await submit(client, tiny_repo, "fixable_v2", attempt=2, previous_patch_id=first)
    v2 = await wait_verdict(client, second)
    assert v2.decision == "REVIEW" and v2.score_history == [v1.score, v2.score]
    assert v2.score > v1.score
    assert journal.get_run(second)["root_id"] == first


async def test_tampering_on_repair_blocks(client, tiny_repo):
    first = await submit(client, tiny_repo, "fixable")
    await wait_verdict(client, first)
    second = await submit(client, tiny_repo, "tamper_skip", attempt=2, previous_patch_id=first)
    v = await wait_verdict(client, second)
    assert v.decision == "BLOCK" and "proof" in v.decision_reason


async def test_malicious_blocks(client, tiny_repo):
    v = await wait_verdict(client, await submit(client, tiny_repo, "malicious"))
    assert v.decision == "BLOCK"
    assert {c.checker for c in v.checks if c.status == "critical"} == {"proof", "safety"}


@pytest.mark.parametrize(
    "body, code",
    [
        ({"attempt": 2}, 422),  # attempt 2 without previous_patch_id
        ({"previous_patch_id": "nope", "attempt": 2}, 404),
        ({"repo_root": "Z:/definitely/missing"}, 400),
        ({"surprise": True}, 422),  # unknown field fails loudly
    ],
)
async def test_bad_requests(client, tiny_repo, body, code):
    base = {"task": TASK, "repo_root": str(tiny_repo), "diff": tiny_diff("good")}
    r = await client.post("/verify", json=base | body)
    assert r.status_code == code, r.text


async def test_cancel_kills_sandbox_and_leaves_repo_untouched(client, tiny_repo):
    before = {p: p.read_bytes() for p in tiny_repo.rglob("*") if p.is_file()}
    pid = await submit(client, tiny_repo, "slow")
    for _ in range(300):  # wait until the tests are running
        run = client.app.state.registry.runs[pid]
        if any("Running baseline" in e.message for e in run.events):
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(1.0)
    r = await client.post(f"/verify/{pid}/cancel")
    assert r.json()["cancelled"] is True
    v = await wait_verdict(client, pid, timeout=20)
    assert v.decision == "BLOCK" and "cancelled" in v.decision_reason
    run = client.app.state.registry.runs[pid]
    assert all(p.poll() is not None for sb in run.handle.sandboxes for p in sb._procs)
    assert all(not sb.base.exists() for sb in run.handle.sandboxes)  # shadows deleted
    after = {p: p.read_bytes() for p in tiny_repo.rglob("*") if p.is_file()}
    assert before == after


async def test_browser_origin_rejected(client):
    r = await client.post("/verify", json={}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


async def test_llm_failover(client, journal):
    body = {"messages": [{"role": "user", "content": "hi"}], "purpose": "demo"}
    r = await client.post("/llm/complete", json=body)
    data = r.json()
    assert (
        r.status_code == 200
        and data["model_used"] == "secondary:backup-fake"
        and data["failed_over"]
    )
    calls = journal.llm_calls()
    assert [c["attempt"] for c in calls] == ["primary", "primary retry", "secondary"]
    assert [c["ok"] for c in calls] == [0, 0, 1]


async def test_llm_unconfigured(journal, monkeypatch):
    for k in (
        "PCP_PRIMARY_PROVIDER",
        "PCP_PRIMARY_BASE_URL",
        "PCP_SECONDARY_PROVIDER",
        "PCP_SECONDARY_BASE_URL",
    ):
        monkeypatch.delenv(k, raising=False)
    app = create_app(journal=journal)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post(
            "/llm/complete", json={"messages": [{"role": "user", "content": "x"}], "purpose": "p"}
        )
    assert r.status_code == 503


async def test_journal_restores_chain_after_restart(client, tiny_repo, journal):
    first = await submit(client, tiny_repo, "fixable")
    await wait_verdict(client, first)
    # a fresh app (server restart) with the same journal still knows the frozen tests
    app2 = create_app(journal=journal, gateway=None)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app2), base_url="http://t"
    ) as c2:
        r = await c2.post(
            "/verify",
            json={
                "task": TASK,
                "repo_root": str(tiny_repo),
                "diff": tiny_diff("tamper_delete"),
                "attempt": 2,
                "previous_patch_id": first,
            },
        )
        v = await wait_verdict(c2, r.json()["patch_id"])
    assert v.decision == "BLOCK"
    assert json.loads(journal.get_run(first)["frozen_json"])["manifest"]["f2p"]
