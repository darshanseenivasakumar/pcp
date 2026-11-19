"""SQLite journal: every verification run and every model call (Task C evidence)."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path

from pcp_verifier.contracts import REPO_ROOT, Verdict

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  patch_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  previous_patch_id TEXT,
  task TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  decision TEXT,
  score INTEGER,
  unproven INTEGER,
  model TEXT,
  tokens INTEGER,
  latency_ms INTEGER,
  failover_ms INTEGER,
  user_decision TEXT,
  checks_json TEXT,
  proof_json TEXT,
  verdict_json TEXT,
  frozen_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  purpose TEXT,
  model TEXT,
  attempt TEXT,
  ok INTEGER,
  latency_ms INTEGER,
  error TEXT
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class Journal:
    def __init__(self, path: str | Path | None = None):
        path = (
            path
            or os.environ.get("PCP_JOURNAL_PATH")
            or REPO_ROOT / "verifier" / "data" / "journal.sqlite"
        )
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(SCHEMA)
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------ runs
    def start_run(
        self, patch_id, root_id, previous_patch_id, task, repo_root, attempt, model=None
    ) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO runs (patch_id, root_id, previous_patch_id, task, repo_root,"
                " attempt, model, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (patch_id, root_id, previous_patch_id, task, repo_root, attempt, model, _now()),
            )
            self._db.commit()

    def finish_run(
        self, verdict: Verdict, frozen: dict, latency_ms: int, failover_ms: int | None = None
    ) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE runs SET decision=?, score=?, unproven=?, latency_ms=?, failover_ms=?,"
                " checks_json=?, proof_json=?, verdict_json=?, frozen_json=? WHERE patch_id=?",
                (
                    verdict.decision,
                    verdict.score,
                    int(verdict.unproven),
                    latency_ms,
                    failover_ms,
                    json.dumps([c.model_dump(mode="json") for c in verdict.checks]),
                    json.dumps(verdict.proof.model_dump(mode="json")) if verdict.proof else None,
                    verdict.model_dump_json(),
                    json.dumps(frozen),
                    verdict.patch_id,
                ),
            )
            self._db.commit()

    def record_user_decision(self, patch_id: str, decision: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE runs SET user_decision=? WHERE patch_id=?", (decision, patch_id)
            )
            self._db.commit()

    def get_run(self, patch_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM runs WHERE patch_id=?", (patch_id,)).fetchone()
        return dict(row) if row else None

    def runs(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute("SELECT * FROM runs ORDER BY created_at")]

    # ------------------------------------------------------------ llm calls
    def log_llm(self, entry: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO llm_calls (ts, purpose, model, attempt, ok, latency_ms, error)"
                " VALUES (?,?,?,?,?,?,?)",
                (
                    _now(),
                    entry.get("purpose"),
                    entry.get("model"),
                    entry.get("attempt"),
                    int(bool(entry.get("ok"))),
                    entry.get("latency_ms"),
                    entry.get("error"),
                ),
            )
            self._db.commit()

    def llm_calls(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute("SELECT * FROM llm_calls ORDER BY id")]
