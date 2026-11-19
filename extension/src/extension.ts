import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";

import { VerifierClient } from "./api/client";
import { GatewayBackend, ScriptedBackend } from "./agent/backends";
import type { AgentBackend } from "./agent/loop";
import { TrueForgeBackend } from "./agent/trueforge";
import type { ContextBundle, ContextRequest } from "./context/assemble";
import { assembleContext, nodeRepoReader, renderContext } from "./context/assemble";
import { ContextPanel } from "./ui/contextPanel";
import type { ActiveReview } from "./ui/controller";
import { cancelCurrent, runVerified } from "./ui/controller";
import { ResiliencePanel } from "./ui/resiliencePanel";

const cfg = () => vscode.workspace.getConfiguration("pcp");

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

const runOptions = () => ({
  client: client(),
  maxAttempts: cfg().get<number>("maxAttempts", 3),
  verdictTimeoutMs: cfg().get<number>("verdictTimeoutMs", 600000),
  writeHunk: hooks.writeHunk,
  onActiveReview: (a: ActiveReview | undefined) => (hooks.activeReview = a),
});

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
  await runVerified({ ...runOptions(), mode: "agent", title: "PCP: Agent task", task, repoRoot: root, backend: backend(), context: ctx.text });
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
  await runVerified({ ...runOptions(), mode: "inline", title: "PCP: Inline edit", task, repoRoot: root, backend: backend(), context: ctx.text });
}

/** Verify one .diff, or replay several as attempts 1..n of a repair loop (demo / bench diffs). */
async function verifyDiffFiles(): Promise<void> {
  const root = repoRoot(vscode.window.activeTextEditor?.document.uri);
  if (!root) return void vscode.window.showErrorMessage("Open the repository folder first.");
  const diffs: string[] = [];
  let firstPath: string | undefined;
  for (;;) {
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
  task = await vscode.window.showInputBox({ title: "Task for this diff", value: task ?? "", ignoreFocusOut: true });
  if (!task || !(await ensureVerifier())) return;
  await runVerified({
    ...runOptions(),
    mode: "diff",
    title: diffs.length > 1 ? "PCP: Repair loop (replayed)" : "PCP: Verify diff",
    task,
    repoRoot: root,
    backend: backend(diffs),
    context: "",
  });
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
    vscode.commands.registerCommand("pcp.verifyDiffFile", guard(verifyDiffFiles)),
    vscode.commands.registerCommand("pcp.cancel", () => {
      if (!cancelCurrent()) void vscode.window.showInformationMessage("PCP: nothing is running.");
    }),
    vscode.commands.registerCommand("pcp.showContext", guard(showContext)),
    vscode.commands.registerCommand("pcp.showResilience", () => ResiliencePanel.show(client)),
  );
  void refresh(false);
  const timer = setInterval(() => void refresh(false), 15000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  cancelCurrent();
}
