import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";

import { VerifierClient } from "./api/client";
import { GatewayBackend, ScriptedBackend } from "./agent/backends";
import type { AgentBackend, LoopResult } from "./agent/loop";
import { TrueForgeBackend } from "./agent/trueforge";
import type { ContextBundle, ContextRequest } from "./context/assemble";
import { assembleContext, nodeRepoReader, renderContext } from "./context/assemble";
import type { McpHost } from "./mcpHost";
import { startMcpHost } from "./mcpHost";
import { AuditPanel } from "./ui/auditPanel";
import { ContextPanel } from "./ui/contextPanel";
import type { ActiveReview } from "./ui/controller";
import { cancelCurrent, runVerified } from "./ui/controller";
import { ResiliencePanel } from "./ui/resiliencePanel";

const cfg = () => vscode.workspace.getConfiguration("pcp");
let mcp: McpHost | undefined;
let lastTask: string | undefined;

function client(): VerifierClient {
  return new VerifierClient({
    baseUrl: cfg().get<string>("verifierUrl", "http://127.0.0.1:8765"),
    timeoutMs: cfg().get<number>("requestTimeoutMs", 15000),
  });
}

function repoRoot(hint?: vscode.Uri): string | undefined {
  const configured = cfg().get<string>("repoRoot", "").trim();
  if (configured) return configured;
  const folder = (hint && vscode.workspace.getWorkspaceFolder(hint)) ?? vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

/** Hooks other modules (MCP server) plug into. */
export const hooks: {
  approveTool?: (req: { tool: string; args: unknown }) => Promise<boolean>;
  writeHunk?: (active: ActiveReview, hunkId: string) => ReturnType<ActiveReview["review"]["accept"]>;
  activeReview?: ActiveReview;
} = {};

async function askApproval(req: { tool: string; args: unknown }): Promise<boolean> {
  if (hooks.approveTool) return hooks.approveTool(req);
  const detail = JSON.stringify(req.args ?? {}).slice(0, 400);
  const pick = await vscode.window.showWarningMessage(`The agent wants to run ${req.tool}.`, { modal: true, detail }, "Allow", "Deny");
  return pick === "Allow";
}

function backend(scripted?: string[]): AgentBackend {
  if (scripted?.length) return new ScriptedBackend(scripted, "replayed .diff files");
  const kind = cfg().get<string>("agentBackend", "trueforge");
  if (kind === "gateway") return new GatewayBackend(client());
  if (kind === "scripted") {
    const root = repoRoot();
    const files = cfg().get<string[]>("scriptedDiffs", []);
    if (!files.length || !root) throw new Error("Set pcp.scriptedDiffs to one .diff path per attempt.");
    return new ScriptedBackend(files.map((f) => readFileSync(join(root, f), "utf8")), "scripted diffs");
  }
  return new TrueForgeBackend({
    baseUrl: cfg().get<string>("trueforge.baseUrl", "http://localhost:8790"),
    model: cfg().get<string>("trueforge.model", ""),
    mcpServerName: cfg().get<string>("trueforge.mcpServerName", "pcp-editor") || undefined,
    approve: askApproval,
  });
}

async function ensureVerifier(): Promise<boolean> {
  try {
    await client().health();
    return true;
  } catch (e) {
    const pick = await vscode.window.showErrorMessage((e as Error).message, "Retry", "Settings");
    if (pick === "Retry") return ensureVerifier();
    if (pick === "Settings") void vscode.commands.executeCommand("workbench.action.openSettings", "pcp.verifierUrl");
    return false;
  }
}

async function buildContext(root: string, req: Omit<ContextRequest, "budgetTokens">, show: boolean): Promise<{ text: string; bundle: ContextBundle }> {
  const bundle = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "PCP: assembling context" },
    () => assembleContext(nodeRepoReader(root), { ...req, budgetTokens: cfg().get<number>("contextTokenBudget", 8000) }),
  );
  if (show) ContextPanel.show(root, req.task, bundle);
  return { text: renderContext(bundle), bundle };
}

function runOptions(task: string) {
  lastTask = task; // run_tests (MCP) verifies against the current task
  return {
    client: client(),
    maxAttempts: cfg().get<number>("maxAttempts", 3),
    verdictTimeoutMs: cfg().get<number>("verdictTimeoutMs", 600000),
    writeHunk: hooks.writeHunk,
    onActiveReview: (a: ActiveReview | undefined) => (hooks.activeReview = a),
  };
}

async function runAgentTask(): Promise<void> {
  const root = repoRoot(vscode.window.activeTextEditor?.document.uri);
  if (!root) return void vscode.window.showErrorMessage("Open the repository folder first.");
  const task = await vscode.window.showInputBox({
    title: "PCP agent task",
    prompt: "Describe the change. The agent finds the files; PCP proves the patch before anything is written.",
    placeHolder: "Add a `flask config` CLI command that shows the app's configuration and masks secret values, with a test and docs.",
    ignoreFocusOut: true,
  });
  if (!task || !(await ensureVerifier())) return;
  const ctx = await buildContext(root, { task }, true);
  await runVerified({ ...runOptions(task), mode: "agent", title: "PCP: Agent task", task, repoRoot: root, backend: backend(), context: ctx.text });
}

async function inlineEdit(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return void vscode.window.showWarningMessage("Select the code to change first.");
  const root = repoRoot(editor.document.uri);
  if (!root) return;
  const rel = relative(root, editor.document.uri.fsPath).replace(/\\/g, "/");
  const sel = editor.selection;
  const instruction = await vscode.window.showInputBox({
    title: `PCP inline edit: ${rel}:${sel.start.line + 1}-${sel.end.line + 1}`,
    prompt: "What should change? The result is verified before you see it.",
    placeHolder: 'Also treat "off" and "n" as false.',
    ignoreFocusOut: true,
  });
  if (!instruction || !(await ensureVerifier())) return;
  const task = `${instruction} (Selected code: ${rel} lines ${sel.start.line + 1}-${sel.end.line + 1}.)`;
  const selection = { startLine: sel.start.line + 1, endLine: sel.end.line + 1, text: editor.document.getText(sel) };
  const ctx = await buildContext(root, { task, focusFile: rel, selection }, false);
  await runVerified({ ...runOptions(task), mode: "inline", title: "PCP: Inline edit", task, repoRoot: root, backend: backend(), context: ctx.text });
}

/** Programmatic form (demo scripts, PCP_AUTORUN): diff paths in attempt order + the task. */
export interface VerifyDiffArgs {
  diffs: string[];
  task?: string;
  repoRoot?: string;
  title?: string;
  /** Demo playback only: hunks to accept automatically after a REVIEW verdict. */
  autoAccept?: { hunks: string[]; delayMs: number };
}

/** Verify one .diff, or replay several as attempts 1..n of a repair loop (demo / bench diffs). */
async function verifyDiffFiles(args?: VerifyDiffArgs): Promise<LoopResult | undefined> {
  const root = args?.repoRoot ?? repoRoot(vscode.window.activeTextEditor?.document.uri);
  if (!root) return void vscode.window.showErrorMessage("Open the repository folder first.");
  const diffs: string[] = (args?.diffs ?? []).map((p) => readFileSync(p, "utf8"));
  let firstPath: string | undefined = args?.diffs[0];
  while (!args) {
    const picked = await vscode.window.showOpenDialog({
      title: diffs.length ? `Attempt ${diffs.length + 1} diff (Cancel to start verifying)` : "Attempt 1 diff",
      filters: { Diff: ["diff", "patch"] },
      canSelectMany: false,
      defaultUri: firstPath ? vscode.Uri.file(dirname(firstPath)) : undefined,
    });
    if (!picked?.[0]) break;
    firstPath ??= picked[0].fsPath;
    diffs.push(readFileSync(picked[0].fsPath, "utf8"));
    if (diffs.length === 3) break;
    const more = await vscode.window.showQuickPick(["Verify now", "Add the next repair attempt"], { title: `${diffs.length} diff(s) chosen` });
    if (more !== "Add the next repair attempt") break;
  }
  if (!diffs.length || !firstPath) return;
  const taskFile = join(dirname(firstPath), "task.json");
  let task = existsSync(taskFile) ? (JSON.parse(readFileSync(taskFile, "utf8")) as { task?: string }).task : undefined;
  task = args?.task ?? task;
  if (!args) task = await vscode.window.showInputBox({ title: "Task for this diff", value: task ?? "", ignoreFocusOut: true });
  if (!task || !(await ensureVerifier())) return;
  return runVerified({
    ...runOptions(task),
    mode: "diff",
    title: args?.title ?? (diffs.length > 1 ? "PCP: Repair loop (replayed)" : "PCP: Verify diff"),
    task,
    repoRoot: root,
    backend: backend(diffs),
    context: "",
    autoAccept: args?.autoAccept,
  });
}

/**
 * PCP: Play Demo. Runs the recording script by itself: good patch -> REVIEW, malicious -> BLOCK,
 * fixable -> REPAIR -> REVIEW with one hunk accepted, then the model failover. Uses the same
 * commands and panels as a developer would; only the pacing and the one Accept click are scripted.
 */
async function playDemo(): Promise<void> {
  const dir = cfg().get<string>("demoTasksDir", "").trim();
  const root = repoRoot(vscode.window.activeTextEditor?.document.uri);
  const pause = cfg().get<number>("demoPauseMs", 7000);
  const a = (f: string) => join(dir, "A", f);
  if (!dir || !root || !existsSync(a("reference.diff")) || !existsSync(a("fixable.diff")) || !existsSync(a("malicious.diff"))) {
    void vscode.window.showErrorMessage("Set pcp.demoTasksDir to the verifier's bench/tasks folder and open the Flask repo.");
    return;
  }
  if (!(await ensureVerifier())) return;

  // The demo patches apply to pristine Flask; a previous take's accepted hunk would make them conflict.
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) {
    const ok = await vscode.window.showWarningMessage(
      "Flask has local changes (probably the hunk accepted in an earlier take). Discard them so the demo patches apply?",
      { modal: true, detail: dirty },
      "Discard and continue",
    );
    if (ok !== "Discard and continue") return;
    execFileSync("git", ["checkout", "--", "."], { cwd: root });
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  status.show();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PCP demo", cancellable: true },
      async (progress, token) => {
        for (let s = 15; s > 0; s--) {
          if (token.isCancellationRequested) return false;
          progress.report({ message: `starts in ${s} s. Start your screen recording now.` });
          await sleep(1000);
        }
        return true;
      },
    );
    if (!started) return;
    const task = (JSON.parse(readFileSync(a("task.json"), "utf8")) as { task: string }).task;
    const step = (n: number, text: string) => {
      status.text = `$(play) PCP demo ${n}/4: ${text}`;
      void vscode.window.showInformationMessage(`Demo ${n}/4: ${text}`);
    };

    step(1, "Task A, a good patch");
    await verifyDiffFiles({ diffs: [a("reference.diff")], task, repoRoot: root, title: "Demo 1: good patch" });
    await sleep(pause);

    step(2, "Task A, a patch that also plants an AWS key");
    await verifyDiffFiles({ diffs: [a("malicious.diff")], task, repoRoot: root, title: "Demo 2: malicious patch" });
    await sleep(pause);

    step(3, "Task A, a wrong first try, repaired automatically; then accept one hunk");
    await verifyDiffFiles({
      diffs: [a("fixable.diff"), a("reference.diff")],
      task,
      repoRoot: root,
      title: "Demo 3: repair loop",
      autoAccept: { hunks: ["h1"], delayMs: pause },
    });
    await sleep(pause);

    step(4, "Task C, break the primary model; the backup answers");
    await ResiliencePanel.play(client, pause);
    status.text = "$(check) PCP demo finished";
    void vscode.window.showInformationMessage("PCP demo finished. Run `git diff` in Flask: only the accepted hunk h1 is on disk.");
    await sleep(pause);
  } finally {
    status.dispose();
  }
}

/** One-click demo scenarios over bench/tasks (pcp.demoTasksDir): no file dialogs on camera. */
async function demo(): Promise<void> {
  const dir = cfg().get<string>("demoTasksDir", "").trim();
  const root = repoRoot(vscode.window.activeTextEditor?.document.uri);
  if (!dir || !existsSync(dir)) {
    void vscode.window.showErrorMessage("Set pcp.demoTasksDir to the verifier's bench/tasks folder (run pcp-bench fetch first).");
    return void vscode.commands.executeCommand("workbench.action.openSettings", "pcp.demoTasksDir");
  }
  const taskOf = (t: string) => (JSON.parse(readFileSync(join(dir, t, "task.json"), "utf8")) as { task: string }).task;
  const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = [];
  for (const [t, label] of [["A", "Task A (inline: get_debug_flag)"], ["B", "Task B (agent: flask config)"]] as const) {
    if (!existsSync(join(dir, t))) continue;
    const d = (f: string) => join(dir, t, f);
    const replay = async (files: string[]) => {
      await verifyDiffFiles({ diffs: files.map(d), task: taskOf(t), repoRoot: root });
    };
    if (existsSync(d("reference.diff"))) items.push({ label: `${label}: good patch`, description: "REVIEW", run: () => replay(["reference.diff"]) });
    if (existsSync(d("fixable.diff")) && existsSync(d("reference.diff"))) {
      items.push({ label: `${label}: fixable, then repaired`, description: "REPAIR -> REVIEW", run: () => replay(["fixable.diff", "reference.diff"]) });
    }
    for (const bad of ["malicious.diff", "sneaky.diff", "tamper_drop_case.diff"]) {
      if (existsSync(d(bad))) items.push({ label: `${label}: ${bad.replace(".diff", "")} patch`, description: "BLOCK", run: () => replay([bad]) });
    }
  }
  items.push({ label: "Task C: model resilience panel", description: "break the primary model", run: async () => void ResiliencePanel.show(client) });
  const pick = await vscode.window.showQuickPick(items, { title: "PCP demo" });
  if (pick && (await ensureVerifier())) await pick.run();
}

async function showContext(): Promise<void> {
  const root = repoRoot(vscode.window.activeTextEditor?.document.uri);
  if (!root) return;
  const task = await vscode.window.showInputBox({ title: "Show the context PCP would retrieve for this task", ignoreFocusOut: true });
  if (task) await buildContext(root, { task }, true);
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "pcp.checkHealth";
  context.subscriptions.push(status);

  const refresh = async (announce: boolean) => {
    try {
      const h = await client().health();
      status.text = "$(shield) PCP";
      status.tooltip = `Verifier ok (v${h.version}, sandbox ${h.sandbox})`;
      if (announce) void vscode.window.showInformationMessage(`PCP verifier is up: v${h.version}, sandbox ${h.sandbox}.`);
    } catch (err) {
      status.text = "$(warning) PCP offline";
      status.tooltip = (err as Error).message;
      if (announce) void vscode.window.showErrorMessage((err as Error).message);
    }
    status.show();
  };

  const guard = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      void vscode.window.showErrorMessage(`PCP: ${(e as Error).message}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("pcp.checkHealth", () => refresh(true)),
    vscode.commands.registerCommand("pcp.runAgentTask", guard(runAgentTask)),
    vscode.commands.registerCommand("pcp.inlineEdit", guard(inlineEdit)),
    vscode.commands.registerCommand("pcp.verifyDiffFile", (args?: VerifyDiffArgs) =>
      guard(async () => {
        await verifyDiffFiles(args);
      })(),
    ),
    vscode.commands.registerCommand("pcp.cancel", () => {
      if (!cancelCurrent()) void vscode.window.showInformationMessage("PCP: nothing is running.");
    }),
    vscode.commands.registerCommand("pcp.showContext", guard(showContext)),
    vscode.commands.registerCommand("pcp.demo", guard(demo)),
    vscode.commands.registerCommand("pcp.playDemo", guard(playDemo)),
    vscode.commands.registerCommand("pcp.showResilience", () => ResiliencePanel.show(client)),
    vscode.commands.registerCommand("pcp.showAuditLog", () => {
      if (!mcp) return void vscode.window.showWarningMessage("PCP: the MCP tool server is still starting.");
      AuditPanel.show(mcp.audit, mcp.url);
    }),
    vscode.commands.registerCommand("pcp.copyMcpUrl", async () => {
      const url = mcp?.url();
      if (!url) return void vscode.window.showWarningMessage("PCP: the MCP tool server is not running.");
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage(`Copied ${url}. In TrueForge: Settings > Connectors > Add MCP Server, name it "pcp-editor".`);
    }),
  );

  void startMcpHost({
    context,
    root: () => repoRoot(vscode.window.activeTextEditor?.document.uri),
    client,
    task: () => lastTask,
    activeReview: () => hooks.activeReview,
  }).then((host) => {
    mcp = host;
    hooks.approveTool = host.approveTool;
    hooks.writeHunk = host.writeHunk;
    context.subscriptions.push({ dispose: () => void host.dispose() });
  });
  void refresh(false);
  // Demo/recording hook: PCP_AUTORUN='{"command":"pcp.verifyDiffFile","args":{...}}' runs one command on start.
  const autorun = process.env.PCP_AUTORUN;
  if (autorun) {
    try {
      const { command, args } = JSON.parse(autorun) as { command: string; args?: unknown };
      if (command.startsWith("pcp.")) setTimeout(() => void vscode.commands.executeCommand(command, args), 1500);
    } catch (e) {
      void vscode.window.showErrorMessage(`PCP_AUTORUN is not valid JSON: ${(e as Error).message}`);
    }
  }
  const timer = setInterval(() => void refresh(false), 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  cancelCurrent();
}
