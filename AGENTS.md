# MASTER PROMPT: Proof-Carrying Patch (PCP), 2-person team, shared repo

> **How to use:** both teammates paste this entire file into their coding agent at the start of every session, then add one line at the end:
> `I am PERSON 1.` or `I am PERSON 2.`
> The agent must then work **only** on that person's part (Section 6 or 7) and follow every shared rule.
> Also save this file in the repo as `AGENTS.md` (and `CLAUDE.md`), so agents read it automatically.

---

## 1. Mission (read first)

You are a senior engineer on a two-person team building **Proof-Carrying Patch (PCP)**: a verification layer that sits between a coding agent and the developer, inside VS Code.

When a coding agent proposes a code change (a "patch"), PCP:
1. **Proves it** by running tests on the old code and the new code in an isolated sandbox. The host runs and reads the tests; the model's word is never trusted.
2. **Scores it** with four independent checkers that all return the same JSON shape, then combines them into one **Patch Confidence Score (0–100)** using plain math, not an LLM.
3. **Routes it.** High score: the developer accepts or rejects each hunk. Middle score: the change goes back to the agent to repair. Low score or critical issue: blocked, and a human decides.

One-line belief: **AI output is untrusted until evidence says otherwise.**

Target: TrueForge Forge-a-thon. The agent loop must run in TrueForge, editor capabilities must be exposed as MCP tools, and there must be **no silent disk writes**. The benchmark repo is **pallets/flask 3.1.3**, with three tasks:
- **Task A (inline edit):** make `get_debug_flag` also treat `"off"` and `"n"` as false.
- **Task B (agent mode, 3+ files, none named):** add a `flask config` CLI command that masks secrets, with a test and docs.
- **Task C (resilience):** fail over automatically from a broken primary model.

`[Confirm the tasks, the rubric and the deadline against the official Techfest PDF before building.]`

---

## 2. Proven designs this is built from (copy the mechanisms)

**PRism** (Microsoft AI Dev Days 2026 Grand Prize; github.com/soni-ishan/PRism)
- Parallel specialist agents with timeouts; every agent returns the same Pydantic model.
- Heuristic regex runs first. A secret short-circuits to `critical`, modifier 90, with no LLM call. Final risk = `max(llm, heuristic)`, so the LLM can't hide a risk.
- Verdict is deterministic: `score = clamp(100 − Σ(modifier × weight))`; blocked if any critical or score < 70. Invariants live inside the schema's `model_validator`.
- A crashed agent becomes a fallback result (modifier 50, warning). The LLM only polishes the summary, with a template fallback.

**codebreaker** (LA Hacks 2026 1st Overall; github.com/KevinWu098/codebreaker)
- Proof by execution: a manifest says "run this command; expect this exit code and this text in stdout". The host runs it in a **fresh sandbox per attempt** and replays the **frozen** manifest on the fix, so the agent can't edit the test to pass.
- A separate **validator** re-opens the cited lines and confirms or dismisses each finding. Confidence bands: 0.9–1.0 proven, 0.7–0.9 plausible, 0.5–0.7 weak, < 0.5 dismiss. Findings must cite files the agent actually opened.
- **Tool tiers** (Read 0, WriteLocal 1, ExecLocal 2, Network 3, …). Each agent gets only the tiers it needs. Every run and tool call is journaled.

**DocSync** (GitLab AI Hackathon 2026, Anthropic Runner-Up; devpost.com/software/pipeheal)
- The detector agent is read-only, and only the writer can edit. Findings are typed, each with a confidence from 0 to 1.
- Routing: confidence ≥ 0.5 → fix; all < 0.5 → human; none → nothing. **If a fix rewrites > 50% of a file, a human decides.**
- JSON Schema contracts on every agent output, so bad output fails fast. (Their lesson: a missing wire failed *silently*, so make failures loud.)

---

## 3. Pipeline

```
Agent proposes diff (TrueForge, in VS Code)              ── PERSON 2
        │  POST /verify
        ▼
[1] PROOF RUNNER: shadow copy, baseline vs patched tests ── PERSON 1
        ▼
[2] CHECKERS in parallel: Proof · Safety · Coverage · Scope ── PERSON 1
        ▼
[3] VALIDATOR: host citation check + LLM confirm/dismiss ── PERSON 1
        ▼
[4] VERDICT: pure math → score + decision               ── PERSON 1
        ▼  SSE events + Verdict JSON
[5] ROUTER UI: REVIEW per-hunk / REPAIR loop / BLOCK    ── PERSON 2
```

Decision rules (Person 1 implements; Person 2 displays):
```
score    = clamp(100 − Σ(modifier_i × weight_i), 0, 100)
weights  = proof 0.35 · safety 0.25 · coverage 0.20 · scope 0.20
decision = BLOCK  if any critical or big_rewrite unapproved
           REVIEW if score ≥ 70
           REPAIR if 40 ≤ score < 70 and attempt < 3
           BLOCK  otherwise
```
A REVIEW with no passing proof run is labelled `unproven` and shown yellow, never green.

---

## 4. Shared repo setup (do together first, ~1–2 hours)

### 4.1 Layout and ownership
```
pcp/
  AGENTS.md / CLAUDE.md     ← this file                       (SHARED)
  contracts/                ← message formats                 (SHARED: both must approve changes)
    schemas/*.json            JSON Schema Draft 7
    pcp_contracts.py          Pydantic models
    types.ts                  TypeScript types
    examples/*.json           one valid sample of every message = everyone's mocks
  fixtures/tiny_repo/       ← small Python repo, 3 functions + tests (SHARED)
  verifier/                 ← PERSON 1 (Python 3.12, FastAPI)
    core/  checkers/  validator/  server.py
    tests/
  bench/                    ← PERSON 1 (runner) · PERSON 2 (seeded_bugs/)
  extension/                ← PERSON 2 (TypeScript, VS Code)
    src/  test/
  scripts/dev.sh            ← starts server + extension dev host (SHARED)
  .github/workflows/ci.yml  ← runs Python + TS tests on every PR (SHARED)
  .github/CODEOWNERS        ← verifier/ → P1, extension/ → P2, contracts/ → both
  QUESTIONS.md  DECISIONS.md  ← async notes between the two of you
```

### 4.2 Git workflow (both agents must follow this exactly)
1. `main` is protected: no direct pushes. CI must pass before merging.
2. Branch names: `p1/<short-topic>` or `p2/<short-topic>`. One topic per branch.
3. Before starting work: `git checkout main && git pull`, then create or rebase your branch on `main`.
4. Commit small and often, with clear messages: `verifier: add tamper detection for skipped tests`.
5. Open a PR when a piece works and its tests pass. Keep PRs under ~400 changed lines. The other person reviews within a few hours; if no review comes, merge after CI passes and say so in chat.
6. **Never edit the other person's folder.** If you need a change there, write it in `QUESTIONS.md` or open an issue.
7. **Contract changes:** a PR that touches only `contracts/` (schemas + Pydantic + TS types + examples together), tagged to both, merged before either side uses it. Never change a contract silently.
8. Rebase on `main` at least once a day to avoid big conflicts. If a conflict is in a shared file, stop and ask the other person.
9. Never commit secrets. `.env` is in `.gitignore`; `.env.example` lists the variable names.

### 4.3 Contracts (freeze these first)

**PatchContext** (inside Person 1's code; what every checker receives)
```json
{
  "patch_id": "uuid", "attempt": 1,
  "task": "plain-English task",
  "repo_root": "/abs/original", "shadow_root": "/abs/shadow",
  "diff": "unified diff",
  "changed_files": ["src/flask/helpers.py"],
  "hunks": [{"hunk_id": "h1", "file": "src/flask/helpers.py", "old_start": 20, "old_lines": 4, "new_start": 20, "new_lines": 6}],
  "proof": "<proof.json>"
}
```

**proof.json**
```json
{
  "attempt": 1, "sandbox": "docker:python3.12 | local-temp",
  "frozen_manifest": {"f2p": ["tests/test_helpers.py::test_debug_flag_off"], "p2p": ["tests/test_helpers.py"]},
  "baseline": {"exit_code": 1, "passed": 41, "failed": 1, "duration_s": 3.2},
  "patched":  {"exit_code": 0, "passed": 42, "failed": 0, "duration_s": 3.4},
  "f2p_ok": true, "p2p_ok": true, "tampering": []
}
```
F2P = "fail-to-pass": new tests that fail on the old code and pass on the new code (this proves the test really tests the change). P2P = "pass-to-pass": existing tests that pass on both (this proves nothing broke).

**CheckResult**
```json
{
  "checker": "proof | safety | coverage | scope",
  "risk_modifier": 0, "status": "pass | warning | critical",
  "findings": [{
    "id": "f1",
    "type": "test_failure | missing_test | tampering | secret | dangerous_call | removed_guard | out_of_scope | big_rewrite | other",
    "source": "heuristic | tool | test_output | llm",
    "confidence": 0.0, "file": "path|null", "line_start": 0, "line_end": 0,
    "evidence": "snippet", "message": "plain English",
    "validated": "confirmed | dismissed | not_required"
  }],
  "recommended_action": "plain English"
}
```

**Verdict** (Person 1 → Person 2)
```json
{
  "patch_id": "uuid", "score": 85, "decision": "REVIEW | REPAIR | BLOCK",
  "unproven": false, "attempt": 2, "score_history": [45, 85],
  "checks": ["CheckResult..."], "proof": "<proof.json>",
  "hunk_evidence": {"h1": {"tests": ["tests/test_helpers.py::test_debug_flag_off"], "result": "pass", "findings": ["f3"]}},
  "repair_instructions": "only when REPAIR: failing checks + trimmed test output",
  "summary_md": "plain-English summary", "created_at": "ISO-8601"
}
```

**Event** (streamed over SSE)
```json
{"patch_id": "uuid", "stage": "proof | checks | validate | verdict", "status": "started | done | failed", "message": "Running 42 tests…", "data": {}}
```

### 4.4 HTTP API (Person 1 serves, Person 2 calls; default `http://127.0.0.1:8765`)
| Endpoint | Purpose |
|---|---|
| `POST /verify` `{task, repo_root, diff, attempt, previous_patch_id?}` → `{patch_id}` | Start verifying |
| `GET /verify/{id}/events` (SSE) | Live progress |
| `GET /verify/{id}` → Verdict | Final result |
| `POST /verify/{id}/cancel` | Stop and kill the sandbox |
| `POST /llm/complete` `{messages, purpose}` → `{text, model_used, failover_ms}` | Optional shared model gateway with fallback |
| `GET /health` | Liveness check |

---

## 5. Rules for every agent (both people)

1. Never write to the user's real files except through a hunk the user accepted.
2. Models produce findings; **code** produces scores and decisions.
3. The host runs and parses tests; never trust model-reported results.
4. Any LLM finding that cites a file or line that doesn't exist, or whose snippet isn't there, is discarded.
5. Validate every message against `contracts/`; fail loudly on mismatch.
6. Deterministic checks first, LLM second; merge with `max()`.
7. Every external call (LLM, sandbox, HTTP) has a timeout and a fallback.
8. Small modules, each with its own tests. Tests must pass without the other person's part running (use `contracts/examples/` as mocks).
9. Stay inside your own folders. Write cross-team questions in `QUESTIONS.md`; record choices in `DECISIONS.md`.
10. Before saying a task is done: run the tests, run the linter, and update the README section for your part.

---

## 6. PERSON 1: Verifier backend (Python)

**Owns:** `verifier/`, `bench/` (runner and reports). **Stack:** Python 3.12, FastAPI, Pydantic v2, pytest, Docker (optional; fall back to a temp-dir sandbox), gitleaks/Semgrep (optional).

### 6.1 Build in this order
1. **Contracts in Python:** load the shared Pydantic models; tests that every file in `contracts/examples/` validates.
2. **Verdict + router:** score formula, decision rules, invariants in a `model_validator` (critical ⇒ not REVIEW; score < 70 ⇒ not REVIEW; big_rewrite ⇒ human), template `summary_md`, `repair_instructions`, `hunk_evidence` map. Test the edge values 39/40 and 69/70.
3. **Proof runner:**
   - Copy the repo to a temp shadow folder (or a container); `git apply` the diff there.
   - Run pytest on baseline and patched with `--junitxml`, a timeout and no network; parse the XML.
   - Find F2P tests (tests added or changed in the diff) and P2P tests (existing tests for changed files, else the whole file's tests).
   - Freeze the manifest on attempt 1. On later attempts, flag `tampering` (→ critical) if a frozen test is deleted, skipped (`skip`/`xfail`) or its asserts are removed.
   - Fresh sandbox per attempt; always clean up; write `proof.json`.
4. **Parallel runner:** `asyncio.gather` over the checkers with per-checker timeouts; crash → fallback (modifier 50, warning).
5. **Checkers** (each is `async def run(ctx: PatchContext) -> CheckResult`):
   - **Proof:** P2P failures → high risk; behavior change without an F2P test → warning; tampering or new regressions → critical.
   - **Safety:** regex first (private keys, `AKIA…`, `ghp_…`, `sk-…`, `password="…"`, Bearer tokens, `eval`/`exec`, `subprocess(shell=True)`, `os.system`, `rm -rf`, removed `try/except`, `DROP TABLE`). A secret → critical 90, no LLM. Then optional gitleaks/Semgrep, then optional LLM; final = `max()`.
   - **Coverage:** map changed source → expected test file; if `coverage.py` is available, check that changed lines are executed.
   - **Scope:** compare the touched files/hunks to the task; flag unrelated files, lockfile/CI/config edits, protected paths (`.git`, `.env`); the >50% rewrite rule → `big_rewrite`.
6. **Validator:** host-side citation check (file exists, lines in range, snippet present), then a read-only LLM confirm/dismiss using codebreaker's bands. Only `source: llm` findings need it.
7. **Server:** FastAPI with the endpoints in 4.4, SSE events at every stage, cancel kills the sandbox, `/health`.
8. **Model gateway** (`/llm/complete`): primary → retry once → secondary; return `model_used` and `failover_ms`; journal it (this is Task C's evidence).
9. **Journal:** SQLite table of every run (task, model, attempt, checks, proof, verdict, tokens, latency, failover, user decision).
10. **`pcp-bench`:** run the tasks and seeded bugs N times per model, then write `bench/results.md` + CSV: success rate, mean score, repair-loop rate, tamper catches, seeded-bug catch rate, false blocks, latency, failover time.

### 6.2 Person 1 tests
Every regex (match and no-match), score math, invariants, routing edges, tamper cases, timeout fallback, citation check, server endpoints (httpx test client), full pipeline on `fixtures/tiny_repo` with good, fixable and malicious diffs.

### 6.3 Done when
`curl` a good, a fixable and a malicious diff → REVIEW, REPAIR then REVIEW, BLOCK, on both `tiny_repo` and Flask, and `bench/results.md` exists with real numbers.

---

## 7. PERSON 2: Editor, agent and UI (TypeScript)

**Owns:** `extension/`, `bench/seeded_bugs/`. **Stack:** TypeScript VS Code extension, webviews, MCP SDK, TrueForge, `@vscode/test-electron` or Vitest.

### 7.1 Build in this order
1. **Mock server** (`extension/dev/mock-server.ts`): serves `contracts/examples/` Verdicts and streams fake Events, so the UI works on day 1 without Person 1's server.
2. **API client** with types from `contracts/types.ts`; handles the verifier being offline (`/health`), timeouts and SSE reconnect.
3. **MCP tools with tiers:** `read_file`, `grep`, `list_dir`, `git_diff` (tier 0, auto); `apply_patch_to_shadow` (1); `run_tests` (2, via the verifier); `write_file` (3, **only after a hunk is accepted**). Shell/write tools need approval; an allow-list (`pytest`, `git diff`) auto-approves. Every call is logged (name, tier, args summary, approved by, time).
4. **TrueForge agent loop:** task + context → diff → `POST /verify` → on REPAIR send `repair_instructions` back and loop (max 3 attempts) → on REVIEW open the review panel → on BLOCK show the reasons. Use TrueForge approvals for tier ≥ 2. `[Read the TrueForge docs for the exact loop/approval APIs and note them in DECISIONS.md.]`
5. **Context assembly** (rubric B1, worth 15 points): symbol search + import-graph retrieval within a token budget; a panel shows each retrieved file and *why* (e.g. "defines `get_debug_flag`", "imports `helpers.py`").
6. **Review panel:** the diff split into hunks with Accept/Reject on each; next to each hunk, its tests and pass/fail from `hunk_evidence` and linked findings; score badge (green ≥ 70, yellow `unproven`, red BLOCK); score history (e.g. 45 → 85); `summary_md`. Accept writes only that hunk.
7. **Live progress + cancel:** stage-by-stage display from SSE; Cancel calls `/cancel` and leaves files untouched.
8. **Inline edit mode** (Task A): select code → type an instruction → verified diff → review panel.
9. **Resilience UI** (Task C): show when the primary model failed and which backup took over, with the failover time (via `/llm/complete`, or TrueForge's own fallback if it has one).
10. **Audit log view:** a table of every tool call and approval.
11. **Seeded bad patches** (`bench/seeded_bugs/`): 10–20 `.diff` files for `tiny_repo` and Flask, each with `expected.json` (expected checker + status): leaked key, deleted test, skipped test, weakened assert, broken edge case, `shell=True`, unrelated file edit, 80% rewrite, fake citation. These feed Person 1's bench and your demo.

### 7.2 Person 2 tests
Diff → hunk parsing; accept writes only that hunk; reject writes nothing; cancel leaves the workspace unchanged (`git status` clean); tier ≥ 2 needs approval; the allow-list works; offline verifier shows a clear message; the repair loop stops at 3.

### 7.3 Done when
In VS Code on Flask: run Task A and Task B, watch the stages stream, see the verdict with evidence beside each hunk, accept one hunk, and only that hunk is on disk. Then break the primary model and watch the fallback happen.

---

## 8. Plan (deadline: Round 1, 20 Nov; confirm on techfest.org)

| Day | Together | Person 1 (backend) | Person 2 (editor) |
|---|---|---|---|
| **15 Nov (tonight)** | Create repo, add `AGENTS.md`, CODEOWNERS, CI, `contracts/` + examples, `tiny_repo` | | |
| **16 Nov** | 15-min sync (morning) | Verdict + router + proof runner on `tiny_repo` | Mock server, API client, MCP tools + tiers + approvals |
| **17 Nov** | 15-min sync | Checkers (Safety, Proof, Scope, Coverage) + parallel runner | TrueForge loop, review panel, progress + cancel |
| **18 Nov** | **Integration:** point the extension at the real server; run the checklist in §9 | Server + SSE + validator + model gateway | Context assembly panel, seeded bugs |
| **19 Nov** | Run Flask Tasks A, B, C end to end; fix bugs together | Journal + `pcp-bench` → `results.md` | Inline edit, resilience UI, audit log, polish |
| **20 Nov** | Record 3-min demo, write the PDF, submit | Bench tables + architecture section | Demo recording + UI screenshots |

**Short-on-time cut:** skip the LLM validator, Semgrep and coverage.py; keep regex safety, the proof runner, verdict, the review panel, cancel and fallback. Those cover the scored essentials.

---

## 9. Integration checklist (18 Nov)
- [ ] Extension talks to the real server; `/health` green.
- [ ] Good diff → REVIEW; fixable → REPAIR → REVIEW (score rises); malicious → BLOCK. On `tiny_repo` and Flask.
- [ ] Every seeded bug is caught by its expected checker.
- [ ] No file changes without an accepted hunk; cancel leaves `git status` clean.
- [ ] Primary model broken → backup takes over; failover time is journaled and shown.
- [ ] CI green on `main`.

## 10. Rubric map (for the write-up)
| Item | Pts | Where it comes from |
|---|---|---|
| A1 Inline Edit | 10 | P2 inline mode + P1 F2P proof for Task A |
| A2 Agent Mode | 10 | P2 agent loop + P1 Scope/Safety on Task B |
| A3 Streaming & Cancel | 10 | P1 SSE + P2 progress/cancel |
| B1 Context Assembly | 15 | P2 retrieval panel with reasons |
| B2 Diff Safety & Review | 10 | P1 proof + checkers, P2 per-hunk panel with evidence |
| B3 Resilience | 10 | P1 gateway fallback + P2 failover UI |
| B4 Harness Depth | 10 | P2 tool tiers, approvals, allow-list, audit log |
| C1 Demo Video | 10 | Good → repaired → blocked, score 45 → 85 |
| C2 Write-up | 15 | P1 `results.md` numbers + architecture + seeded-bug catch rate |

## 11. Definition of done
One command (`scripts/dev.sh`) starts everything. Flask Tasks A–C run end to end. Good patches reach REVIEW with green proof; fixable ones are repaired automatically; malicious or test-deleting ones are blocked with a clear reason. Nothing reaches disk without approval. CI is green, and the README shows the test count and the bench results.
