// Runs one verified task end to end and drives the review panel:
// agent -> verifier (live stages) -> REVIEW: per-hunk Accept/Reject | REPAIR: loop | BLOCK: reasons.
import * as vscode from "vscode";

import type { VerifierClient } from "../api/client";
import type { AgentBackend, LoopResult } from "../agent/loop";
import { runRepairLoop } from "../agent/loop";
import type { HunkWrite } from "../core/hunks";
import { HunkReview } from "../core/hunks";
import { ResiliencePanel } from "./resiliencePanel";
import type { ReviewMessage } from "./reviewPanel";
import { ReviewPanel } from "./reviewPanel";
import type { ReviewViewState } from "./reviewState";
import { addLog, applyEvent, applyVerdict, initialState, setHunkState, startAttempt } from "./reviewState";
import { vscodeWorkspaceFs } from "./vscodeFs";

/** The open review the MCP write_file tool may write through (tier 3). */
export interface ActiveReview {
  patchId: string;
  review: HunkReview;
  /** Hunks the developer clicked Accept on. write_file may only apply these. */
  userAccepted: Set<string>;
}

export interface RunOptions {
  mode: ReviewViewState["mode"];
  title: string;
  task: string;
  repoRoot: string;
  backend: AgentBackend;
  client: VerifierClient;
  context: string;
  maxAttempts: number;
  verdictTimeoutMs: number;
  /** Writes one accepted hunk; defaults to review.accept. The MCP layer routes it through write_file + audit. */
  writeHunk?: (active: ActiveReview, hunkId: string) => Promise<HunkWrite>;
  onActiveReview?: (active: ActiveReview | undefined) => void;
}

let current: AbortController | undefined;

/** pcp.cancel: stop the running verification (kills the sandbox; files untouched). */
export function cancelCurrent(): boolean {
  if (!current) return false;
  current.abort();
  return true;
}

export async function runVerified(o: RunOptions): Promise<LoopResult> {
  if (current) {
    const choice = await vscode.window.showWarningMessage("A PCP verification is already running.", "Cancel it and start", "Keep it");
    if (choice !== "Cancel it and start") throw new Error("Another verification is running.");
    current.abort();
  }
  const ac = new AbortController();
  current = ac;
  const state = initialState({ title: o.title, mode: o.mode, task: o.task, backend: o.backend.name, maxAttempts: o.maxAttempts });
  let active: ActiveReview | undefined;
  const writeHunk = o.writeHunk ?? ((a: ActiveReview, id: string) => a.review.accept(id));

  const accept = async (id: string) => {
    if (!active || !state.canAccept) return;
    active.userAccepted.add(id);
    try {
      const w = await writeHunk(active, id);
      setHunkState(state, id, "accepted");
      addLog(state, `${id}: written to ${w.file}`);
      const hunk = active.review.diff.hunks.find((h) => h.hunk_id === id);
      if (hunk && w.action === "write") await reveal(o.repoRoot, w.file, hunk.new_start);
    } catch (e) {
      active.userAccepted.delete(id);
      setHunkState(state, id, "pending", (e as Error).message);
      addLog(state, `${id}: ${(e as Error).message}`, "error");
    }
    panel.refresh();
  };

  const onMessage = async (m: ReviewMessage) => {
    switch (m.type) {
      case "cancel":
        ac.abort();
        addLog(state, "Cancel requested: stopping the sandbox");
        break;
      case "accept":
        await accept(m.id);
        break;
      case "acceptAll":
        for (const h of state.hunks.filter((x) => x.state === "pending")) await accept(h.id);
        break;
      case "reject":
        try {
          active?.review.reject(m.id);
          setHunkState(state, m.id, "rejected");
          addLog(state, `${m.id}: rejected (nothing written)`);
        } catch (e) {
          setHunkState(state, m.id, "accepted", (e as Error).message);
        }
        break;
      case "open":
        await reveal(o.repoRoot, m.file, m.line ?? 1);
        break;
    }
    panel.refresh();
  };

  const panel = new ReviewPanel(o.title, () => state, (m) => void onMessage(m));
  panel.onDispose(() => {
    if (current === ac) ac.abort();
    if (active) o.onActiveReview?.(undefined);
  });

  let result: LoopResult;
  try {
    result = await runRepairLoop({
      backend: o.backend,
      client: o.client,
      task: o.task,
      repoRoot: o.repoRoot,
      context: o.context,
      maxAttempts: o.maxAttempts,
      verdictTimeoutMs: o.verdictTimeoutMs,
      signal: ac.signal,
      hooks: {
        onLog: (l) => {
          addLog(state, l);
          panel.refresh();
        },
        onAttempt: (n) => {
          startAttempt(state, n);
          panel.refresh();
        },
        onProposal: (p) => {
          if (p.modelUsed) state.model = { used: p.modelUsed, failedOver: p.failedOver, failoverMs: p.failoverMs };
          if (p.modelUsed?.includes(":")) {
            ResiliencePanel.record(
              { model_used: p.modelUsed, failover_ms: p.failoverMs ?? 0, failed_over: p.failedOver, errors: p.errors ?? [] },
              `agent attempt ${state.attempt}`,
            );
          }
          panel.refresh();
        },
        onSubmitted: (id, n) => addLog(state, `Attempt ${n} submitted to the verifier (patch ${id.slice(0, 8)})`),
        onEvent: (e) => {
          applyEvent(state, e);
          panel.refresh();
        },
        onVerdict: (v, _diff, parsed) => {
          applyVerdict(state, v, parsed);
          panel.refresh();
        },
      },
    });
  } catch (e) {
    result = { status: "failed", attempts: [], message: (e as Error).message };
  } finally {
    if (current === ac) current = undefined;
  }

  state.running = false;
  state.outcome = { status: result.status, message: result.message };
  if (result.status === "failed") addLog(state, result.message, "error");
  if (result.parsed && result.verdict && result.patchId) {
    if (result.status !== "review") state.canAccept = false;
    active = { patchId: result.patchId, review: new HunkReview(vscodeWorkspaceFs(o.repoRoot), result.parsed), userAccepted: new Set() };
    if (result.status === "review") o.onActiveReview?.(active);
  }
  panel.refresh();
  panel.reveal();

  const say = { review: "info", blocked: "error", gave_up: "warn", cancelled: "info", failed: "error" }[result.status];
  const show = say === "error" ? vscode.window.showErrorMessage : say === "warn" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  void show(`PCP: ${result.message}`);
  return result;
}

async function reveal(root: string, file: string, line: number): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), file);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, selection: new vscode.Range(pos, pos) });
  } catch {
    /* the file may not exist yet (new file hunk not accepted) */
  }
}
