# PCP VS Code extension (Person 2)

The editor side of Proof-Carrying Patch: the agent loop, the per-hunk review panel, context
assembly, the resilience panel, and the MCP tool server with tiers, approvals and an audit log.
The extension never trusts the model: every patch goes to the verifier, and nothing reaches your
files except a hunk you accepted.

## Run it

```bash
cd extension
npm ci
npm run build
```

Then start the verifier (repo root, see the main README), open the target repo (e.g.
`bench/repos/flask`) and press F5 on this folder, or run:

```bash
code --extensionDevelopmentPath="$PWD" ../bench/repos/flask
```

No verifier yet? `npm run mock` serves the `contracts/examples/` verdicts on :8765
(`MOCK_SCENARIO=auto|review|repair|block|unproven|always-repair`, `MOCK_PRIMARY_DOWN=1`).

## Commands

| Command | What it does | Rubric |
|---|---|---|
| **PCP: Inline Edit (verified)** (`Ctrl+Alt+K` on a selection) | Instruction on selected code → agent diff → verify → review panel | A1 |
| **PCP: Run Agent Task (verified)** | Task, no files named → context assembly → agent loop (REPAIR fed back, max 3) | A2 |
| **PCP: Verify .diff File(s) / Replay Repair Loop** | Verify one diff, or replay several as attempts 1..n | A2, C1 |
| **PCP: Demo…** | One click: good / fixable→repaired / malicious, Task C panel (needs `pcp.demoTasksDir`) | C1 |
| **PCP: Cancel Verification** (or Cancel in the panel) | Aborts the stream and calls `/cancel`; files untouched | A3 |
| **PCP: Show Assembled Context** | Files retrieved for a task and *why* | B1 |
| **PCP: Model Resilience** | `/llm/status`, Break/Hang/Restore primary, test prompt with failover time | B3 |
| **PCP: Show Tool Audit Log** | Every tool call: tier, args, approved by, outcome | B4 |
| **PCP: Copy MCP Server URL** | `http://127.0.0.1:8766/mcp` for TrueForge → Settings → Connectors | B4 |

## Settings

`pcp.verifierUrl` (default `http://127.0.0.1:8765`), `pcp.repoRoot`, `pcp.agentBackend`
(`trueforge` | `gateway` | `scripted`), `pcp.trueforge.baseUrl` / `.model` / `.mcpServerName`,
`pcp.mcpPort` (8766), `pcp.allowList` (`["pytest", "git diff"]`), `pcp.maxAttempts` (3),
`pcp.contextTokenBudget` (8000), `pcp.demoTasksDir`.

## Agent backends

- **TrueForge** (`@truefoundry/trueforge-sdk`): `sessions.create` with an inline agent spec
  (model, instructions, our MCP server with `requireApprovalForTools`), `createTurnStream`;
  `tool.approval_required` is answered through PCP's approval gate with `createTurnEvents`
  (`user.tool_approval`), then `subscribeToTurn` resumes. The final message's ```diff block is the patch.
- **Model gateway**: the verifier's `/llm/complete`, so a broken primary model fails over and the
  panel shows which model answered (Task C).
- **Scripted**: replays `.diff` files; deterministic demos and tests.

## How it is built

```
src/api/        VerifierClient: timeouts, one clear offline message, SSE with id de-dup + reconnect,
                every response validated against contracts/schemas (ajv) + Verdict invariants
src/core/       diff parser (h1..hN in diff order = verifier hunk_evidence keys), HunkReview:
                Accept writes exactly one hunk, Reject writes nothing, .git/.env refused
src/agent/      runRepairLoop (attempt/previous_patch_id chaining, max 3), backends, prompts
src/context/    symbol + import-graph retrieval with reasons and a token budget
src/mcp/        tool tiers 0-3, ApprovalGate (allow-list, prompts, TrueForge pre-approval),
                AuditLog (JSONL), ToolRunner, streamable-HTTP MCP server
src/ui/         webview panels (views/* hold the HTML/JS, no vscode import), controller
```

Webviews never make HTTP calls (the verifier rejects browser origins); they post messages to the
extension host, which owns every request and every disk write.

## Tests

```bash
npm run lint   # tsc --noEmit + eslint
npm test       # vitest: 132 tests, no verifier needed (mock server + temp git repos)
```

Covers hunk parsing, accept writes only that hunk and reject writes nothing (checked with
`git status`), cancel leaves `git status` clean, the repair loop stops at 3, tier ≥ 2 needs
approval, the allow-list, offline/timeout messages, SSE reconnect, contract validation, the
TrueForge approval flow, context ranking, and the MCP server over HTTP.

Against the real verifier (skipped otherwise):

```bash
PCP_REAL_URL=http://127.0.0.1:8765 npx vitest run test/real-server.test.ts
PCP_CAPTURE_URL=http://127.0.0.1:8765 PCP_BENCH=<verifier>/bench npx vitest run test/capture.preview.test.ts
```

The second one renders the real panel code with states from real Flask runs into
`out/preview/*.html`; `docs/screenshots/` came from there.
