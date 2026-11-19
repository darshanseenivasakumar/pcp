from __future__ import annotations

import json

from pcp_verifier import bench


def test_scenarios_reference_existing_diffs():
    for s in bench.scenarios():
        assert s.diff.is_file(), s.id
        assert s.expect in {"REVIEW", "REPAIR", "BLOCK"}


def test_seeded_bug_parsing(tmp_path, monkeypatch):
    root = tmp_path / "bench"
    (root / "seeded_bugs" / "tiny").mkdir(parents=True)
    (root / "seeded_bugs" / "tiny" / "leak.diff").write_text("--- a/x\n+++ b/x\n")
    (root / "seeded_bugs" / "tiny" / "leak.expected.json").write_text(
        json.dumps(
            {"repo": "tiny_repo", "expected_checker": "safety", "expected_status": "critical"}
        )
    )
    monkeypatch.setattr(bench, "BENCH", root)
    (s,) = bench.seeded_scenarios()
    assert (s.id, s.repo, s.expect, s.expect_checker) == (
        "seeded/tiny/leak",
        "tiny",
        "BLOCK",
        "safety",
    )


async def test_bench_runs_one_scenario_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setattr(bench, "BENCH", tmp_path)
    rows = await bench.run_all(1, only="tiny/good")
    assert [(r.scenario.id, r.decision, r.ok) for r in rows] == [("tiny/good", "REVIEW", True)]
    md = bench.write_report(rows, await bench.failover_bench(1), 1)
    assert "100% (1/1)" in md and (tmp_path / "results.csv").is_file()
