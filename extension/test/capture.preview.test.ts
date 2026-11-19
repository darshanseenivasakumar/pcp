// Renders the real panel code with states from REAL verifier runs into static HTML (for the
// write-up screenshots and for checking the UI without VS Code). Skipped unless PCP_CAPTURE_URL:
//   PCP_CAPTURE_URL=http://127.0.0.1:8765 PCP_BENCH=<server worktree>/bench npx vitest run test/capture.preview.test.ts
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { VerifierClient } from "../src/api/client";
import { ScriptedBackend } from "../src/agent/backends";
import { runRepairLoop } from "../src/agent/loop";
import { assembleContext, nodeRepoReader } from "../src/context/assemble";
import type { ParsedDiff } from "../src/core/diff";
import { HunkReview, nodeWorkspaceFs } from "../src/core/hunks";
import { AuditLog } from "../src/mcp/audit";
import { ApprovalGate } from "../src/mcp/tiers";
import { ToolRunner } from "../src/mcp/tools";
import type { ReviewViewState } from "../src/ui/reviewState";
import { addLog, applyEvent, applyVerdict, initialState, setHunkState, startAttempt } from "../src/ui/reviewState";
import * as audit from "../src/ui/views/audit";
import * as context from "../src/ui/views/context";
import * as resilience from "../src/ui/views/resilience";
import * as review from "../src/ui/views/review";
import { page } from "../src/ui/webview";

const URL = process.env.PCP_CAPTURE_URL;
const BENCH = process.env.PCP_BENCH ?? join(__dirname, "..", "..", "bench");
const FLASK = join(BENCH, "repos", "flask");
const OUT = join(__dirname, "..", "out", "preview");
const read = (p: string) => readFileSync(p, "utf8");
// Read lazily: this file is skipped in CI, where bench/tasks does not exist.
const task = (t: "A" | "B") => (JSON.parse(read(join(BENCH, "tasks", t, "task.json"))) as { task: string }).task;

// VS Code "Dark Modern" theme variables, so the preview looks like the webview.
const THEME = `:root{--vscode-font-family:"Segoe UI",system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;
--vscode-editor-font-size:12.5px;--vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-descriptionForeground:#9d9d9d;
--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;
--vscode-panel-border:#3c3c3c;--vscode-textLink-foreground:#4daafc;--vscode-textCodeBlock-background:#2b2b2b;--vscode-badge-background:#616161;
--vscode-badge-foreground:#f8f8f8;--vscode-progressBar-background:#0078d4}`;

function write(name: string, view: { CSS: string; SCRIPT: string }, state: unknown): void {
  mkdirSync(OUT, { recursive: true });
  let html = page({ cspSource: "'self'" } as never, name, THEME + view.CSS, view.SCRIPT);
  html = html.replace(/<script nonce="([^"]+)">/, `<script nonce="$1">window.acquireVsCodeApi = () => ({ postMessage() {} });`);
  html = html.replace(
    "</script></body>",
    `\nwindow.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: ${JSON.stringify(state).replace(/</g, "\\u003c")} } }));</script></body>`,
  );
  writeFileSync(join(OUT, `${name}.html`), html);
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Runs scripted diffs through the real verifier, building the same view state the panel shows. */
async function runScenario(c: VerifierClient, title: string, diffs: string[], snapshotWhen?: (s: ReviewViewState) => boolean) {
  const s = initialState({ title, mode: "diff", task: task("A"), backend: "replayed .diff files", maxAttempts: 3 });
  let snapshot: ReviewViewState | undefined;
  let parsed: ParsedDiff | undefined;
  const r = await runRepairLoop({
    backend: new ScriptedBackend(diffs.map(read), "replayed .diff files"),
    client: c,
    task: task("A"),
    repoRoot: FLASK,
    context: "",
    hooks: {
      onLog: (l) => addLog(s, l),
      onAttempt: (n) => startAttempt(s, n),
      onEvent: (e) => {
        applyEvent(s, e);
        if (!snapshot && snapshotWhen?.(s)) snapshot = clone(s);
      },
      onVerdict: (v, _d, p) => {
        applyVerdict(s, v, p);
        parsed = p;
      },
    },
  });
  s.running = false;
  s.outcome = { status: r.status, message: r.message };
  return { s, r, snapshot, parsed };
}

describe.skipIf(!URL)("capture panel previews from real verifier runs", () => {
  const c = new VerifierClient({ baseUrl: URL ?? "", timeoutMs: 30_000 });

  it("Flask Task A: fixable -> REPAIR -> fixed -> REVIEW, then accept one hunk", async () => {
    const { s, r, snapshot, parsed } = await runScenario(
      c,
      "PCP: Repair loop (Flask Task A)",
      [join(BENCH, "tasks", "A", "fixable.diff"), join(BENCH, "tasks", "A", "reference.diff")],
      (st) => st.attempt === 2 && st.stages[1]!.status === "started",
    );
    expect(r.status).toBe("review");
    if (snapshot) write("1-streaming", review, { ...snapshot, running: true });

    // Accept h1 for real, on a scratch copy of the files the diff touches.
    const scratch = mkdtempSync(join(tmpdir(), "pcp-preview-"));
    for (const f of parsed!.files) {
      mkdirSync(dirname(join(scratch, f.path)), { recursive: true });
      cpSync(join(FLASK, f.path), join(scratch, f.path));
    }
    const w = await new HunkReview(nodeWorkspaceFs(scratch), parsed!).accept("h1");
    setHunkState(s, "h1", "accepted");
    addLog(s, `h1: written to ${w.file}`);
    write("2-review", review, s);
  }, 240_000);

  it("Flask Task A malicious diff -> BLOCK", async () => {
    const { s, r } = await runScenario(c, "PCP: Verify diff (Flask Task A)", [join(BENCH, "tasks", "A", "malicious.diff")]);
    expect(r.status).toBe("blocked");
    write("3-block", review, s);
  }, 120_000);

  it("Task C: break the primary model, the backup answers", async () => {
    await c.llmSimulate({ primary: "fail" });
    const t0 = Date.now();
    const res = await c.llmComplete({ purpose: "resilience_probe", messages: [{ role: "user", content: "Reply with: pong" }], max_tokens: 5 });
    const total = Date.now() - t0;
    const status = await c.llmStatus();
    expect(res.failed_over).toBe(true);
    write("4-failover", resilience, {
      status,
      probes: [
        { time: new Date().toLocaleTimeString(), modelUsed: res.model_used, failedOver: true, failoverMs: res.failover_ms, totalMs: total, errors: res.errors ?? [], source: "test prompt" },
      ],
    });
    await c.llmSimulate({ primary: "ok" });
  }, 60_000);

  it("context panel for Flask Task B", async () => {
    const bundle = await assembleContext(nodeRepoReader(FLASK), { task: task("B"), budgetTokens: 8000 });
    write("5-context", context, { task: task("B"), bundle });
  }, 60_000);

  it("audit log: tiers, allow-list, denial, accepted-hunk write", async () => {
    const log = new AuditLog();
    const gate = new ApprovalGate({ allowList: ["pytest", "git diff"], prompter: { ask: async () => false } });
    const ref = read(join(BENCH, "tasks", "A", "reference.diff"));
    const runner = new ToolRunner({ root: FLASK, verifier: c, task: () => task("A") }, gate, log);
    await runner.call("read_file", { path: "src/flask/helpers.py", start_line: 20, end_line: 35 }, "mcp");
    await runner.call("grep", { pattern: "def get_debug_flag" }, "mcp");
    await runner.call("apply_patch_to_shadow", { diff: ref }, "mcp");
    await runner.call("run_tests", { diff: ref, task: task("A") }, "mcp");
    await runner.call("run_command", { argv: ["curl", "https://example.com"] }, "mcp");
    await runner.call("read_file", { path: ".env" }, "mcp");
    await runner.call("write_file", { hunk_id: "h1" }, "mcp");
    write("6-audit", audit, { entries: log.entries(), mcpUrl: "http://127.0.0.1:8766/mcp" });
    expect(log.entries().length).toBe(7);
  }, 180_000);
});
