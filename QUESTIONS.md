# Questions (async, between P1 and P2)

Format: `- [ ] (P1→P2, 2026-11-15) question` — tick and answer inline when resolved.

- [ ] (P1→both, 2026-11-15) Confirm Tasks A/B/C, the rubric and the 20 Nov deadline against the official Techfest PDF.
- [x] (P1→P2, 2026-11-15) TrueForge: which model/fallback and approval APIs exist? If TrueForge has its own failover, should `/llm/complete` still be the Task C path?
  - **P2, 19 Nov:** TrueForge has no documented model fallback (one model per agent; per-turn selection is "planned"), so **`/llm/complete` stays the Task C path**. Approvals: `requireApprovalForTools` on the agent's MCP server entry; the turn pauses with `tool.approval_required`, answered via `createTurnEvents` (`user.tool_approval`) + `subscribeToTurn`. Details in DECISIONS.md.
- [x] (P1→P2, 2026-11-15) `contracts/types.ts` is hand-written. Do you want codegen from `contracts/schemas/` (json-schema-to-typescript) instead?
  - **P2, 19 Nov:** keep it hand-written. The extension validates every message at runtime against `contracts/schemas/*.json` (ajv), and `extension/test/contracts.test.ts` checks every example, so drift fails loudly in CI.
- [x] (P1→P2, 2026-11-15) Proposed contract addition for 19 Nov: `POST /verify/{id}/decision {hunk_id, decision: accept|reject}` so the journal records user decisions. OK?
  - **P2, 19 Nov:** OK in principle, but not for the 20 Nov cut: it is not in contracts 0.2.0. Accept/Reject are already recorded in the extension's audit log (`write_file`, tier 3, "accepted hunk hN"). Easy to add after Round 1.
- [x] (P1→P2, 2026-11-16) **P2, 19 Nov: P1 owns the seeded bugs now (per the 19 Nov plan), so the shape is P1's call.** Seeded bugs: `pcp-bench` reads `bench/seeded_bugs/**/<name>.diff` plus `<name>.expected.json` (or one `expected.json` per folder, optionally keyed by diff name) with keys `repo` (`tiny`|`flask`), `task`, `expected_checker`, `expected_status` (`warning`|`critical`), optional `expected_decision`. OK, or do you prefer another shape?
- [x] (P1→P2, 2026-11-16) **P2, 19 Nov: handled** (202 → keep polling, 500 → error shown; the panel follows the SSE `verdict` event, then fetches). `GET /verify/{id}` returns **202** `{"patch_id", "status": "running", "message"}` while running, and 500 `{"status": "failed"}` on an internal error. Listen to SSE `verdict` events to know when to fetch.
