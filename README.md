# Proof-Carrying Patch (PCP)

A verification layer between a coding agent and the developer. Every agent patch is **proved** by running tests on old vs new code in a sandbox, **scored** by four independent checkers with plain math (0–100), and **routed**: REVIEW per-hunk, REPAIR loop, or BLOCK. *AI output is untrusted until evidence says otherwise.*

Read [`AGENTS.md`](AGENTS.md) first: it is the team's master prompt and rules.

## Quick start

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e "./verifier[dev]"   # Windows; use .venv/bin/python elsewhere
cp .env.example .env
scripts/dev.sh            # or: powershell scripts/dev.ps1
```

## Layout

| Path | Owner | What |
|---|---|---|
| `contracts/` | both | Pydantic models (source of truth), generated JSON Schemas, `types.ts`, examples (= mocks) |
| `fixtures/tiny_repo/` | both | 3-function repo + diffs for good / fixable / tamper / malicious patches |
| `verifier/` | Person 1 | Proof runner, checkers, validator, verdict, FastAPI server, model gateway, journal |
| `bench/` | P1 (runner) · P2 (`seeded_bugs/`) | Benchmark runner and results |
| `extension/` | Person 2 | VS Code extension, MCP tools, TrueForge agent loop, review UI |

Contract changes: edit `contracts/pcp_contracts.py`, run `python contracts/gen_schemas.py`, update `types.ts` + `examples/` in one contracts-only PR.

## Person 1: verifier

**Run it:** `scripts/dev.sh` (or `scripts/dev.ps1`) → `http://127.0.0.1:8765`. API in AGENTS.md §4.4; `GET /verify/{id}` returns 202 `{"status":"running"}` until the Verdict is ready.

**Pipeline** (`verifier/pcp_verifier/pipeline.py`):
1. **Proof** (`core/proof_runner.py`, `core/sandbox.py`, `core/testscan.py`): two fresh shadow copies per attempt. *Baseline* = old code + only the patch's test changes; *patched* = full patch. pytest runs in both, in parallel, and the host parses the junit XML. F2P = tests the patch adds or changes (AST); they must fail on baseline and pass on patched. P2P = every baseline-passing test must still pass. The manifest is frozen on attempt 1; on later attempts, a protected test that is deleted, skipped, weakened (fewer real asserts) or loses parametrize cases is **tampering**.
2. **Checkers** in parallel (`checkers/`), each `async run(ctx) -> CheckResult`, with a 30 s timeout; a crash or timeout becomes a fallback (50, warning):
   - **proof:** regression 100; F2P still failing 90; vacuous test 60; no test 40; tampering critical 95.
   - **safety:** secret regex → critical 90 (evidence masked, no LLM); `eval`/`exec`/`shell=True`/`os.system`/`rm -rf`/`DROP TABLE` warnings; removed try/except; optional semgrep / LLM.
   - **coverage:** related test files touched; coverage.py data from the proof run flags changed lines no test runs.
   - **scope:** `.git`/`.env`/keys critical; CI/lockfile/packaging edits; files unrelated to the task; >50% rewrite → `big_rewrite`.
3. **Validator** (`validator/`): every `llm` finding needs a real citation (file, line range, snippet) or it's dismissed; then LLM confirm/dismiss bands; surviving findings merge with `max()`.
4. **Verdict** (`core/verdict.py`): `score = clamp(100 − Σ modifier×weight)`, and `decide()` routes it. Invariants are enforced in `contracts/pcp_contracts.py`.

**Model gateway** (`gateway/`, `POST /llm/complete`): primary → retry once → secondary, configured by `PCP_PRIMARY_*`/`PCP_SECONDARY_*` (OpenAI-compatible or `fake`). Every call is journaled.
**Task C demo (break the primary model live):**
```bash
curl -X POST http://127.0.0.1:8765/llm/simulate -H 'Content-Type: application/json' -d '{"primary":"fail"}'     # or "timeout", then "ok" to restore
curl http://127.0.0.1:8765/llm/status     # which model answered last + last failover_ms
```
A failing primary (HTTP 503) is retried once (300 ms backoff) and then the backup answers in ~0.3 s. A hanging primary is not retried, so the backup answers one timeout later.
**Journal:** SQLite `verifier/data/journal.sqlite` (runs + llm_calls).
**Docker sandbox (opt-in):** `docker build -t pcp-sandbox:py312 -f verifier/docker/Dockerfile.sandbox verifier/docker`, then set `PCP_SANDBOX=docker`. Tests run with `--network none` (verified by a test that tries to connect out). Same decisions as local; slower on Windows.
**Security:** `/verify` executes tests, so the server only binds localhost, rejects browser origins, and honours `PCP_API_TOKEN`.

**Tests:** `.venv/Scripts/python -m pytest verifier -q`, which runs 198 tests (real pytest runs on `fixtures/tiny_repo`; the 4 Docker tests skip when Docker is not running).

**Bench:** `pcp-bench fetch` (clones Flask 3.1.3, builds `bench/.venvs/flask`, generates `bench/tasks/{A,B}/*.diff`), then `pcp-bench run --n 3` → [`bench/results.md`](bench/results.md). Latest: **57/57 runs routed correctly, 0 false blocks, 12/12 tamper attempts and 6/6 malicious patches blocked, repair loop 9/9, failover to the backup model in ~310 ms (HTTP 503) or ~1.0 s (hang).** Latest run (20 Nov, 34 scenarios incl. 15 seeded bugs): **102/102 routed correctly, seeded-bug catch rate 45/45, 0 false blocks**. Latency depends on the repo and machine load: Flask ~11 s per verification on an idle laptop (17.8 s under ~70% background CPU), tiny_repo ~3 s.

## Person 2: extension

**Run it:** `cd extension && npm ci && npm run build`, then F5 on `extension/` (or `scripts/dev.sh`, which also opens VS Code with the extension on `bench/repos/flask`). Full guide: [`extension/README.md`](extension/README.md).

- **Agent loop** (`src/agent/`): task + context → TrueForge (or the `/llm/complete` gateway, or replayed `.diff` files) → `POST /verify` → REPAIR feeds `repair_instructions` back with `attempt`/`previous_patch_id` (max 3) → REVIEW opens the panel → BLOCK shows `decision_reason`. The loop never writes files.
- **Review panel** (B2, A3): live stages from SSE (de-duplicated by id, reconnects, falls back to polling), Cancel (`/cancel`, files untouched), score badge (green proven / yellow unproven / amber repair / red block), score history, `summary_md`, and the diff split into `h1..hN` with each hunk's tests (old vs new outcome) and findings. **Accept writes exactly that hunk; Reject writes nothing.**
- **Inline edit** (A1, `Ctrl+Alt+K` on a selection) and **agent mode** (A2) commands; **PCP: Demo…** runs the `bench/tasks` scenarios in one click.
- **Context panel** (B1): symbol + import-graph retrieval in a token budget, each file with *why* ("defines `get_debug_flag`", "tests `helpers.py`", "path matches `cli`").
- **Resilience panel** (B3): polls `/llm/status`; Break/Hang/Restore primary via `/llm/simulate`; shows which model answered and the failover time.
- **MCP tools** (B4) at `127.0.0.1:8766/mcp` for TrueForge: tier 0 read (auto), 1 shadow apply (auto, in memory), 2 `run_tests`/`run_command` (allow-list `pytest`, `git diff`, else approval; TrueForge approvals go through the same gate), 3 `write_file` (accepted hunks only). Every call is in the audit log.
- Every verifier message is validated against `contracts/schemas` (ajv) plus the Verdict invariants; the webviews never make HTTP calls.

**Tests:** `cd extension && npm run lint && npm test`, which runs 132 tests with no verifier needed (mock server + temp git repos): hunk parsing, accept-only-that-hunk / reject-writes-nothing via `git status`, cancel leaves `git status` clean, repair loop stops at 3, tier ≥ 2 approval and allow-list, offline/timeout messages, SSE reconnect, TrueForge approval flow, MCP over HTTP. `PCP_REAL_URL=http://127.0.0.1:8765 npx vitest run test/real-server.test.ts` runs good/fixable/malicious/failover against the real verifier.

**Write-up section and screenshots:** [`extension/docs/WRITEUP-editor.md`](extension/docs/WRITEUP-editor.md). **Demo script:** [`extension/docs/DEMO.md`](extension/docs/DEMO.md).

## Integration check (AGENTS.md §9), 20 Nov 01:23

Run on the merged tree (all P1 + P2 PRs), real verifier server, fake models.

- [x] Extension talks to the real server: `PCP_REAL_URL=http://127.0.0.1:8765 npx vitest run test/real-server.test.ts` → 4/4 (health, SSE stream, verdict polling).
- [x] Good → REVIEW, fixable → REPAIR → REVIEW (score rises), malicious → BLOCK on **tiny_repo** (extension client) and **Flask** over `curl`: A 100 · A 69 → 100 · A malicious BLOCK · B (4 files) 100.
- [x] Every seeded bug caught by its expected checker: **15/15**, and all 15 routed as expected (`bench/seeded_bugs/tiny/`, generated by `python bench/seeded_bugs/make_seeded.py`). They cover leaked AWS key, GitHub token, PEM key, `.env` edit, deleted / skipped / weakened test, 80% rewrite, broken edge case, removed try/except, `shell=True`, `eval`, `DROP TABLE`, an unrelated file and a CI edit. Not covered: a fake LLM citation (needs a real model).
- [x] No file changes without an accepted hunk (extension tests); cancel mid-run on Flask → BLOCK "cancelled", `git status` clean before and after.
- [x] Primary broken (`/llm/simulate fail`) → backup answers in 311 ms; every attempt journaled.
- [x] CI: Python 205 tests + ruff + schema check; extension lint + 132 tests + build.
