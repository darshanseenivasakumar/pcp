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

_Status: in progress. See below once built._

## Person 2: extension

_Person 2 fills this in._
