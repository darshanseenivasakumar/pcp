# 3-minute demo script

## Setup (before recording)

1. Start the verifier from the `p1/llm-demo` checkout, using fake models and Flask's Python for
   the tests:

   ```
   set PCP_PRIMARY_PROVIDER=fake& set PCP_SECONDARY_PROVIDER=fake& set PCP_PRIMARY_MODEL=gpt-primary& set PCP_SECONDARY_MODEL=claude-backup& set PCP_TARGET_PYTHON=%CD%\bench\.venvs\flask\Scripts\python.exe& .venv\Scripts\python -m pcp_verifier.server
   ```

2. Build the extension (`cd extension && npm ci && npm run build`). Open
   `bench/repos/flask` with the extension loaded (F5, or
   `code --extensionDevelopmentPath=<repo>/extension <repo>/bench/repos/flask`).
3. Settings: set `pcp.demoTasksDir` to `<repo>/bench/tasks`. The status bar should read
   **PCP** (green shield).
4. Open `src/flask/helpers.py`, and run `git status` in a terminal to show the tree is clean.

## Script

| Time | Do | Say |
|---|---|---|
| 0:00 | Show `helpers.py` and a clean `git status` | "Coding agents write patches fast. PCP treats each patch as untrusted until tests prove it." |
| 0:15 | **PCP: Demo…** → *Task A: good patch* | "The patch goes to the verifier. Watch the stages stream: proof, the four checkers, the validator, the verdict." |
| 0:40 | Point at the **100 PROVEN** badge, then scroll to `h1` | "Green means proven. The new test fails on the old code and passes on the new code, so it really tests the change. The evidence sits next to each hunk." |
| 0:55 | Click **Accept** on `h1` only, then show `git status` / `git diff` | "Accept writes exactly that hunk. Nothing else touched disk." |
| 1:10 | **PCP: Demo…** → *Task A: fixable, then repaired* | "This agent's first try is wrong." Wait for **69 REPAIR**. "The verifier's repair instructions go back to the agent automatically." Wait for **100 PROVEN**, history **69 → 100**. |
| 1:45 | **PCP: Demo…** → *Task A: malicious patch* | "This patch fixes the bug but plants an AWS key." Show **BLOCKED**, the safety finding beside `h1`, Accept greyed out. "Code decides, not the model. A critical finding always blocks." |
| 2:15 | **PCP: Demo…** → *Task C: model resilience* → **Break primary model**, then **Send a test prompt** | "We break the primary model live. The gateway retries once and fails over: the backup answers, and you can see how long the failover took." Click **Restore primary**. |
| 2:40 | **PCP: Show Tool Audit Log** (and **Show Assembled Context** for Task B, if time allows) | "Every tool the agent touched is tiered and journaled. Reads are automatic, exec needs approval or the allow-list, and writes need an accepted hunk." |
| 2:55 | End on the review panel | "Proof-carrying patches: AI output stays untrusted until evidence says otherwise." |

## Backup plan

If the live UI misbehaves, the same panels with real-run data are in `extension/out/preview/`.
Regenerate them with `PCP_CAPTURE_URL=http://127.0.0.1:8765 npx vitest run test/capture.preview.test.ts`
and open them in a browser. Static screenshots are in `docs/screenshots/`.
