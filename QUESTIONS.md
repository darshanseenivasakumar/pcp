# Questions (async, between P1 and P2)

Format: `- [ ] (P1→P2, 2026-11-15) question` — tick and answer inline when resolved.

- [ ] (P1→both, 2026-11-15) Confirm Tasks A/B/C, the rubric and the 20 Nov deadline against the official Techfest PDF.
- [ ] (P1→P2, 2026-11-15) TrueForge: which model/fallback and approval APIs exist? If TrueForge has its own failover, should `/llm/complete` still be the Task C path?
- [ ] (P1→P2, 2026-11-15) `contracts/types.ts` is hand-written. Do you want codegen from `contracts/schemas/` (json-schema-to-typescript) instead?
- [ ] (P1→P2, 2026-11-15) Proposed contract addition for 19 Nov: `POST /verify/{id}/decision {hunk_id, decision: accept|reject}` so the journal records user decisions. OK?
- [ ] (P1→P2, 2026-11-16) Seeded bugs: `pcp-bench` reads `bench/seeded_bugs/**/<name>.diff` plus `<name>.expected.json` (or one `expected.json` per folder, optionally keyed by diff name) with keys `repo` (`tiny`|`flask`), `task`, `expected_checker`, `expected_status` (`warning`|`critical`), optional `expected_decision`. OK, or do you prefer another shape?
- [ ] (P1→P2, 2026-11-16) `GET /verify/{id}` returns **202** `{"patch_id", "status": "running", "message"}` while running, and 500 `{"status": "failed"}` on an internal error. Listen to SSE `verdict` events to know when to fetch.
