// Audit log view (B4): every tool call and approval, newest first, live.
import * as vscode from "vscode";

import type { AuditLog } from "../mcp/audit";
import { CSS, SCRIPT } from "./views/audit";
import { page } from "./webview";

export class AuditPanel {
  private static current: AuditPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(audit: AuditLog, mcpUrl: () => string | undefined): void {
    if (AuditPanel.current) return AuditPanel.current.panel.reveal();
    AuditPanel.current = new AuditPanel(audit, mcpUrl);
  }

  private constructor(
    private readonly audit: AuditLog,
    private readonly mcpUrl: () => string | undefined,
  ) {
    this.panel = vscode.window.createWebviewPanel("pcp.audit", "PCP: Audit log", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = page(this.panel.webview, "PCP audit", CSS, SCRIPT);
    const off = audit.onChange(() => this.render());
    this.panel.webview.onDidReceiveMessage((m: { type: string }) => m.type === "ready" && this.render());
    this.panel.onDidDispose(() => {
      off();
      AuditPanel.current = undefined;
    });
  }

  private render(): void {
    void this.panel.webview.postMessage({ type: "state", state: { entries: this.audit.entries(), mcpUrl: this.mcpUrl() } });
  }
}
