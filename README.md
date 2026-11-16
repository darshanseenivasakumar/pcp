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
**Journal:** SQLite `verifier/data/journal.sqlite` (runs + llm_calls).
**Docker sandbox (opt-in):** `docker build -t pcp-sandbox:py312 -f verifier/docker/Dockerfile.sandbox verifier/docker`, then set `PCP_SANDBOX=docker`. Tests run with `--network none` (verified by a test that tries to connect out). Same decisions as local; slower on Windows.
**Security:** `/verify` executes tests, so the server only binds localhost, rejects browser origins, and honours `PCP_API_TOKEN`.

**Tests:** `.venv/Scripts/python -m pytest verifier -q`, which runs 198 tests (real pytest runs on `fixtures/tiny_repo`; the 4 Docker tests skip when Docker is not running).

**Bench:** `pcp-bench fetch` (clones Flask 3.1.3, builds `bench/.venvs/flask`, generates `bench/tasks/{A,B}/*.diff`), then `pcp-bench run --n 3` → [`bench/results.md`](bench/results.md). Latest: **57/57 runs routed correctly, 0 false blocks, 12/12 tamper attempts and 6/6 malicious patches blocked, repair loop 9/9, failover to the backup model in ~310 ms.**

## Person 2: extension

_Person 2 fills this in._
