// Wires the editor MCP server into VS Code: approval prompts, the write gate backed by the open
// review, the audit log, and the hooks the agent loop and review panel use.
import { join } from "node:path";
import * as vscode from "vscode";

import type { VerifierClient } from "./api/client";
import type { HunkWrite } from "./core/hunks";
import { AuditLog, summarizeArgs } from "./mcp/audit";
import type { McpServerHandle } from "./mcp/server";
import { startMcpServer } from "./mcp/server";
import type { Prompter, Tier } from "./mcp/tiers";
import { ApprovalGate } from "./mcp/tiers";
import type { WriteGate } from "./mcp/tools";
import { RUN_TESTS_COMMAND, ToolRunner } from "./mcp/tools";
import type { ActiveReview } from "./ui/controller";

export interface McpHost {
  audit: AuditLog;
  gate: ApprovalGate;
  runner: ToolRunner;
  url(): string | undefined;
  /** TrueForge approval request -> PCP policy; remembered so the MCP call is not asked twice. */
  approveTool(req: { tool: string; args: unknown }): Promise<boolean>;
  /** Review panel Accept -> write_file (tier 3, audited). */
  writeHunk(active: ActiveReview, hunkId: string): Promise<HunkWrite>;
  dispose(): Promise<void>;
}

const vscodePrompter: Prompter = {
  async ask(q) {
    const pick = await vscode.window.showWarningMessage(
      `The agent wants to run ${q.tool} (tier ${q.tier}).`,
      { modal: true, detail: [q.summary, q.command ? `Command: ${q.command}` : ""].filter(Boolean).join("\n") },
      "Allow",
      "Deny",
    );
    return pick === "Allow";
  },
};

export async function startMcpHost(o: {
  context: vscode.ExtensionContext;
  root: () => string | undefined;
  client: () => VerifierClient;
  task: () => string | undefined;
  activeReview: () => ActiveReview | undefined;
}): Promise<McpHost> {
  const cfg = () => vscode.workspace.getConfiguration("pcp");
  await vscode.workspace.fs.createDirectory(o.context.globalStorageUri);
  const audit = new AuditLog({ jsonlPath: join(o.context.globalStorageUri.fsPath, "audit.jsonl") });
  const gate = new ApprovalGate({ allowList: cfg().get<string[]>("allowList", ["pytest", "git diff"]), prompter: vscodePrompter });
  o.context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pcp.allowList")) gate.setAllowList(cfg().get<string[]>("allowList", []));
    }),
  );

  const writeGate = (): WriteGate | undefined => {
    const a = o.activeReview();
    if (!a) return undefined;
    return {
      patchId: a.patchId,
      isAccepted: (id) => a.userAccepted.has(id),
      applyAccepted: (id) => a.review.accept(id),
    };
  };

  const runner = new ToolRunner(
    {
      get root() {
        return o.root() ?? process.cwd();
      },
      // re-read pcp.verifierUrl on every call
      verifier: {
        verify: (...a) => o.client().verify(...a),
        events: (...a) => o.client().events(...a),
        waitForVerdict: (...a) => o.client().waitForVerdict(...a),
      },
      task: o.task,
      writeGate,
    },
    gate,
    audit,
  );

  let server: McpServerHandle | undefined;
  const port = cfg().get<number>("mcpPort", 8766);
  try {
    server = await startMcpServer({ port, runner });
  } catch (e) {
    void vscode.window.showWarningMessage(`PCP: MCP server could not start on port ${port}: ${(e as Error).message}`);
  }

  const tierOf = (tool: string): Tier => runner.list().find((t) => t.name === tool)?.tier ?? 3;

  return {
    audit,
    gate,
    runner,
    url: () => server?.url,
    async approveTool({ tool, args }) {
      const tier = tierOf(tool);
      const a = (args ?? {}) as Record<string, unknown>;
      const command =
        tool === "run_tests" ? RUN_TESTS_COMMAND : tool === "run_command" && Array.isArray(a.argv) ? (a.argv as string[]).join(" ") : undefined;
      const hunk = typeof a.hunk_id === "string" && o.activeReview()?.userAccepted.has(a.hunk_id) ? a.hunk_id : null;
      const t0 = Date.now();
      const d = await gate.decide({ tool, tier, summary: `TrueForge asks to call ${tool} ${summarizeArgs(args, 100)}`, command, args, acceptedHunk: hunk });
      if (d.allowed) gate.preApprove(tool, args);
      audit.append({
        tool,
        tier,
        args: summarizeArgs(args),
        approvedBy: d.approvedBy,
        outcome: d.allowed ? "ok" : "denied",
        durationMs: Date.now() - t0,
        source: "agent",
        detail: "TrueForge approval request",
      });
      return d.allowed;
    },
    async writeHunk(active, hunkId) {
      const out = await runner.call("write_file", { hunk_id: hunkId }, "panel");
      if (!out.ok) throw new Error(out.text);
      const data = out.data as { file: string; action: string } | undefined;
      return { hunkId, file: data?.file ?? "", action: data?.action === "delete" ? "delete" : "write", bytes: 0 };
    },
    async dispose() {
      await server?.close();
    },
  };
}
