"""pcp-bench: replay known patches through the real pipeline and report numbers.

    pcp-bench fetch            clone pallets/flask 3.1.3, build its venv, make the task diffs
    pcp-bench run [--n 3]      run every scenario N times -> bench/results.md + results.csv

Scenarios: tiny_repo fixture diffs, Flask Tasks A/B (bench/tasks), Person 2's
seeded bugs (bench/seeded_bugs/**/<name>.diff + <name>.expected.json or
expected.json), and Task C (gateway failover with a broken primary model).
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from pcp_verifier.contracts import REPO_ROOT, LLMMessage, LLMRequest, VerifyRequest
from pcp_verifier.gateway import FakeProvider, Gateway
from pcp_verifier.pipeline import ChainState, PipelineResult, verify

BENCH = REPO_ROOT / "bench"
TINY = REPO_ROOT / "fixtures" / "tiny_repo"
FLASK = BENCH / "repos" / "flask"
FLASK_PY = BENCH / ".venvs" / "flask" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
TINY_TASK = 'Make parse_bool also treat "on" as true.'


@dataclass
class Scenario:
    id: str
    repo: str  # "tiny" | "flask"
    task: str
    diff: Path
    expect: str  # REVIEW | REPAIR | BLOCK
    kind: str  # good | unproven | fixable | repaired | tamper | malicious | warning | seeded
    prev: str | None = None
    expect_unproven: bool = False
    expect_checker: str | None = None  # seeded bugs: which checker must flag it
    expect_status: str | None = None


def _flask_task(t: str) -> str:
    return json.loads((BENCH / "tasks" / t / "task.json").read_text(encoding="utf-8"))["task"]


def scenarios() -> list[Scenario]:
    d = TINY / "diffs"
    out = [
        Scenario("tiny/good", "tiny", TINY_TASK, d / "good.diff", "REVIEW", "good"),
        Scenario("tiny/no_test", "tiny", TINY_TASK, d / "no_test.diff", "REVIEW", "unproven", expect_unproven=True),
        Scenario("tiny/fixable", "tiny", TINY_TASK, d / "fixable.diff", "REPAIR", "fixable"),
        Scenario("tiny/fixable->v2", "tiny", TINY_TASK, d / "fixable_v2.diff", "REVIEW", "repaired", prev="tiny/fixable"),
        Scenario("tiny/regression", "tiny", TINY_TASK, d / "regression.diff", "REPAIR", "fixable"),
        Scenario("tiny/tamper_skip", "tiny", TINY_TASK, d / "tamper_skip.diff", "BLOCK", "tamper", prev="tiny/fixable"),
        Scenario("tiny/tamper_weaken", "tiny", TINY_TASK, d / "tamper_weaken.diff", "BLOCK", "tamper", prev="tiny/fixable"),
        Scenario("tiny/tamper_delete", "tiny", TINY_TASK, d / "tamper_delete.diff", "BLOCK", "tamper", prev="tiny/fixable"),
        Scenario("tiny/malicious", "tiny", TINY_TASK, d / "malicious.diff", "BLOCK", "malicious"),
    ]  # fmt: skip
    if FLASK.is_dir() and (BENCH / "tasks" / "A" / "task.json").is_file():
        a, b = _flask_task("A"), _flask_task("B")
        ta, tb = BENCH / "tasks" / "A", BENCH / "tasks" / "B"
        out += [
            Scenario("flask/A/reference", "flask", a, ta / "reference.diff", "REVIEW", "good"),
            Scenario("flask/A/no_test", "flask", a, ta / "no_test.diff", "REVIEW", "unproven", expect_unproven=True),
            Scenario("flask/A/fixable", "flask", a, ta / "fixable.diff", "REPAIR", "fixable"),
            Scenario("flask/A/fixable->ref", "flask", a, ta / "reference.diff", "REVIEW", "repaired", prev="flask/A/fixable"),
            Scenario("flask/A/tamper_drop_case", "flask", a, ta / "tamper_drop_case.diff", "BLOCK", "tamper", prev="flask/A/fixable"),
            Scenario("flask/A/malicious", "flask", a, ta / "malicious.diff", "BLOCK", "malicious"),
            Scenario("flask/B/reference", "flask", b, tb / "reference.diff", "REVIEW", "good"),
            Scenario("flask/B/fixable", "flask", b, tb / "fixable.diff", "REPAIR", "fixable"),
            Scenario("flask/B/fixable->ref", "flask", b, tb / "reference.diff", "REVIEW", "repaired", prev="flask/B/fixable"),
            Scenario("flask/B/sneaky", "flask", b, tb / "sneaky.diff", "REVIEW", "warning"),
        ]  # fmt: skip
    out += seeded_scenarios()
    return out


def seeded_scenarios() -> list[Scenario]:
    """Person 2's seeded bugs. Accepted expected.json keys: repo (tiny|flask), task,
    expected_checker | checker, expected_status | status, expected_decision | decision."""
    root = BENCH / "seeded_bugs"
    out = []
    for diff in sorted(root.rglob("*.diff")) if root.is_dir() else []:
        meta_path = diff.with_suffix(".expected.json")
        if not meta_path.is_file():
            meta_path = diff.parent / "expected.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if isinstance(meta, dict) and diff.stem in meta and isinstance(meta[diff.stem], dict):
            meta = meta[diff.stem]
        repo = meta.get("repo", "tiny")
        repo = "flask" if "flask" in str(repo).lower() else "tiny"
        status = meta.get("expected_status") or meta.get("status")
        decision = (
            meta.get("expected_decision")
            or meta.get("decision")
            or ("BLOCK" if status == "critical" else "REVIEW")
        )
        out.append(
            Scenario(
                id=f"seeded/{diff.relative_to(root).with_suffix('').as_posix()}",
                repo=repo,
                task=meta.get("task") or (TINY_TASK if repo == "tiny" else _flask_task("A")),
                diff=diff,
                expect=decision,
                kind="seeded",
                expect_checker=meta.get("expected_checker") or meta.get("checker"),
                expect_status=status,
            )
        )
    return out


# ------------------------------------------------------------------ running
@dataclass
class Row:
    scenario: Scenario
    iteration: int
    decision: str
    score: int
    unproven: bool
    latency_ms: int
    ok: bool
    caught: bool | None
    note: str


def _judge(s: Scenario, res: PipelineResult) -> tuple[bool, bool | None, str]:
    v = res.verdict
    ok = v.decision == s.expect and (v.unproven == s.expect_unproven or s.expect != "REVIEW")
    caught = None
    note = v.decision_reason
    if s.expect_checker:
        check = next((c for c in v.checks if c.checker == s.expect_checker), None)
        if check is None:
            caught = False
        elif s.expect_status == "critical":
            caught = check.status == "critical"
        elif s.expect_status == "warning":
            caught = check.status in {"warning", "critical"}
        else:
            caught = check.status != "pass"
        ok = ok and caught
        note = f"{s.expect_checker}: {check.status if check else 'missing'}"
    return ok, caught, note


async def run_all(n: int, only: str | None = None) -> list[Row]:
    rows: list[Row] = []
    todo = [s for s in scenarios() if not only or only in s.id]
    tmp = Path(tempfile.mkdtemp(prefix="pcp-bench-"))
    tiny_copy = tmp / "tiny_repo"
    shutil.copytree(TINY, tiny_copy, ignore=shutil.ignore_patterns("diffs", "__pycache__"))
    try:
        for i in range(n):
            results: dict[str, PipelineResult] = {}
            for s in todo:
                repo = tiny_copy if s.repo == "tiny" else FLASK
                if s.repo == "flask" and FLASK_PY.is_file():
                    os.environ["PCP_TARGET_PYTHON"] = str(FLASK_PY)
                else:
                    os.environ.pop("PCP_TARGET_PYTHON", None)
                chain, attempt = None, 1
                if s.prev:
                    prev = results.get(s.prev)
                    if prev is None:
                        continue
                    chain = ChainState(prev.frozen, list(prev.verdict.score_history))
                    attempt = prev.verdict.attempt + 1
                req = VerifyRequest(
                    task=s.task,
                    repo_root=str(repo),
                    diff=s.diff.read_text(encoding="utf-8"),
                    attempt=attempt,
                )
                res = await verify(req, f"bench-{i}-{s.id}", chain=chain)
                results[s.id] = res
                ok, caught, note = _judge(s, res)
                v = res.verdict
                rows.append(
                    Row(s, i, v.decision, v.score, v.unproven, res.latency_ms, ok, caught, note)
                )
                mark = "ok " if ok else "BAD"
                print(
                    f"[{mark}] #{i} {s.id:28} {v.decision:6} {v.score:3}{' unproven' if v.unproven else ''}  {res.latency_ms}ms",
                    flush=True,
                )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return rows


async def failover_bench(n: int) -> list[dict]:
    """Task C: primary model broken, measure how fast the backup takes over."""
    out = []
    req = LLMRequest(messages=[LLMMessage(role="user", content="ping")], purpose="bench:failover")
    for mode in ("fail", "timeout"):
        for _ in range(n):
            gw = Gateway(
                FakeProvider("primary", mode=mode),
                FakeProvider("backup", reply="pong"),
                timeout_s=1.0,
            )
            t0 = time.monotonic()
            r = await gw.complete(req)
            out.append({
                "mode": mode, "model_used": r.model_used, "failover_ms": r.failover_ms,
                "total_ms": int((time.monotonic() - t0) * 1000), "ok": r.text == "pong",
            })  # fmt: skip
    from pcp_verifier.gateway import gateway_from_env

    real = gateway_from_env()
    if real is not None:
        for _ in range(n):
            t0 = time.monotonic()
            try:
                r = await real.complete(req)
                out.append({"mode": "real", "model_used": r.model_used, "failover_ms": r.failover_ms,
                            "total_ms": int((time.monotonic() - t0) * 1000), "ok": True})  # fmt: skip
            except Exception as e:  # noqa: BLE001
                out.append({"mode": "real", "model_used": f"error: {e}", "failover_ms": 0,
                            "total_ms": int((time.monotonic() - t0) * 1000), "ok": False})  # fmt: skip
    return out


# ------------------------------------------------------------------ report
def _pct(a: int, b: int) -> str:
    return f"{100 * a / b:.0f}% ({a}/{b})" if b else "n/a"


def _q(values: list[int], q: float) -> int:
    if not values:
        return 0
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


def write_report(rows: list[Row], failover: list[dict], n: int) -> str:
    by_kind = lambda *k: [r for r in rows if r.scenario.kind in k]  # noqa: E731
    lat = [r.latency_ms for r in rows]
    tamper, malicious = by_kind("tamper"), by_kind("malicious")
    seeded = by_kind("seeded")
    should_pass = [r for r in rows if r.scenario.expect != "BLOCK"]
    false_blocks = [r for r in should_pass if r.decision == "BLOCK"]
    repaired = by_kind("repaired")
    fo = [f for f in failover if f["mode"] != "real"]
    lines = [
        "# PCP bench results",
        "",
        f"Generated {time.strftime('%Y-%m-%d %H:%M')} by `pcp-bench run --n {n}`, on {sys.platform},"
        f" sandbox `{os.environ.get('PCP_SANDBOX', 'local')}`. Every patch was really applied and its tests"
        " really run (baseline and patched); no number below comes from a model.",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Scenario runs | {len(rows)} ({len({r.scenario.id for r in rows})} scenarios × {n}) |",
        f"| Correct routing (decision as expected) | {_pct(sum(r.ok for r in rows), len(rows))} |",
        f"| Mean score: good patches | {statistics.mean([r.score for r in by_kind('good', 'repaired')] or [0]):.1f} |",
        f"| Mean score: fixable (first attempt) | {statistics.mean([r.score for r in by_kind('fixable')] or [0]):.1f} |",
        f"| Repair loop success (REPAIR → REVIEW) | {_pct(sum(r.decision == 'REVIEW' for r in repaired), len(repaired))} |",
        f"| Tamper catches (deleted/skipped/weakened/dropped case) | {_pct(sum(r.decision == 'BLOCK' for r in tamper), len(tamper))} |",
        f"| Malicious patches blocked | {_pct(sum(r.decision == 'BLOCK' for r in malicious), len(malicious))} |",
        f"| Seeded-bug catch rate (expected checker fired) | {_pct(sum(bool(r.caught) for r in seeded), len(seeded))} |",
        f"| False blocks (should pass, got BLOCK) | {_pct(len(false_blocks), len(should_pass))} |",
        f"| Unproven correctly flagged | {_pct(sum(r.unproven for r in by_kind('unproven')), len(by_kind('unproven')))} |",
        f"| Latency p50 / p95 | {_q(lat, 0.5) / 1000:.1f}s / {_q(lat, 0.95) / 1000:.1f}s |",
        f"| Task C failover (broken primary → backup) | {_pct(sum(f['ok'] for f in fo), len(fo))} succeeded, "
        f"mean failover {statistics.mean([f['failover_ms'] for f in fo] or [0]):.0f} ms |",
        "",
        "## Per scenario",
        "",
        "| Scenario | Expected | Got (decision · score) | Correct | Mean latency | Note |",
        "|---|---|---|---|---|---|",
    ]
    for sid in dict.fromkeys(r.scenario.id for r in rows):
        rs = [r for r in rows if r.scenario.id == sid]
        s = rs[0].scenario
        got = ", ".join(
            sorted(
                {f"{r.decision} · {r.score}" + (" (unproven)" if r.unproven else "") for r in rs}
            )
        )
        exp = s.expect + (" (unproven)" if s.expect_unproven else "")
        lines.append(
            f"| `{sid}` | {exp} | {got} | {sum(r.ok for r in rs)}/{len(rs)} | "
            f"{statistics.mean(r.latency_ms for r in rs) / 1000:.1f}s | {rs[-1].note[:70]} |"
        )
    lines += [
        "",
        "## Task C: model failover",
        "",
        "| Primary failure | Runs | Backup answered | Mean failover | Max failover |",
        "|---|---|---|---|---|",
    ]
    for mode in dict.fromkeys(f["mode"] for f in failover):
        fs = [f for f in failover if f["mode"] == mode]
        lines.append(
            f"| {mode} | {len(fs)} | {_pct(sum(f['ok'] for f in fs), len(fs))} | "
            f"{statistics.mean(f['failover_ms'] for f in fs):.0f} ms | {max(f['failover_ms'] for f in fs)} ms |"
        )
    lines += [
        "",
        "`fail` = primary returns HTTP 503: retried once (300 ms backoff), then the backup answers."
        " `timeout` = primary hangs past the 1 s timeout: not retried (a hung model usually hangs"
        " again), so the backup answers one timeout later. `failover_ms` = time from the request to"
        " the switch.",
        "",
    ]
    md = "\n".join(lines)
    (BENCH / "results.md").write_text(md, encoding="utf-8", newline="\n")
    with open(BENCH / "results.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(
            [
                "iteration",
                "scenario",
                "kind",
                "expected",
                "decision",
                "score",
                "unproven",
                "correct",
                "caught",
                "latency_ms",
            ]
        )
        for r in rows:
            w.writerow([r.iteration, r.scenario.id, r.scenario.kind, r.scenario.expect, r.decision, r.score,
                        r.unproven, r.ok, "" if r.caught is None else r.caught, r.latency_ms])  # fmt: skip
    return md


# ------------------------------------------------------------------ fetch
def fetch() -> None:
    if not FLASK.is_dir():
        FLASK.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "-c", "core.autocrlf=false", "clone", "--depth", "1", "--branch", "3.1.3",
             "https://github.com/pallets/flask.git", str(FLASK)],
            check=True,
        )  # fmt: skip
    if not FLASK_PY.is_file():
        subprocess.run([sys.executable, "-m", "venv", str(FLASK_PY.parents[1])], check=True)
        lock = (FLASK / "uv.lock").read_text(encoding="utf-8")
        marker = lock.index('name = "pytest"\nversion = "')
        pytest_ver = lock[marker:].split('"')[3]
        subprocess.run(
            [str(FLASK_PY), "-m", "pip", "install", "-q", str(FLASK), "asgiref", "greenlet",
             f"pytest=={pytest_ver}", "python-dotenv", "coverage"],
            check=True,
        )  # fmt: skip
    subprocess.run(
        [sys.executable, str(BENCH / "tasks" / "make_flask_diffs.py"), str(FLASK)], check=True
    )
    print(f"flask ready at {FLASK}, python {FLASK_PY}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pcp-bench")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    r = sub.add_parser("run")
    r.add_argument("--n", type=int, default=3)
    r.add_argument("--only", help="substring filter on scenario ids")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles are cp1252
    if args.cmd == "fetch":
        fetch()
        return 0
    rows = asyncio.run(run_all(args.n, args.only))
    failover = asyncio.run(failover_bench(max(5, args.n)))
    print(write_report(rows, failover, args.n))
    return 0 if all(r.ok for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
