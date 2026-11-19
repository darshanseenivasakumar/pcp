// Context panel (B1): every file PCP retrieved for the agent and WHY, with its token cost.
import * as vscode from "vscode";

import type { ContextBundle } from "../context/assemble";
import { CSS, SCRIPT } from "./views/context";
import { page } from "./webview";

export class ContextPanel {
  private static current: ContextPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private state: { task: string; bundle: ContextBundle };

  static show(root: string, task: string, bundle: ContextBundle): void {
    if (ContextPanel.current) {
      ContextPanel.current.state = { task, bundle };
      ContextPanel.current.root = root;
      ContextPanel.current.render();
      ContextPanel.current.panel.reveal(undefined, true);
      return;
    }
    ContextPanel.current = new ContextPanel(root, task, bundle);
  }

  private constructor(
    private root: string,
    task: string,
    bundle: ContextBundle,
  ) {
    this.state = { task, bundle };
    this.panel = vscode.window.createWebviewPanel("pcp.context", "PCP: Context", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = page(this.panel.webview, "PCP context", CSS, SCRIPT);
    this.panel.webview.onDidReceiveMessage(async (m: { type: string; file?: string; line?: number }) => {
      if (m.type === "ready") this.render();
      if (m.type === "open" && m.file) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.Uri.file(this.root), m.file));
        const pos = new vscode.Position(Math.max(0, (m.line ?? 1) - 1), 0);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(pos, pos) });
      }
    });
    this.panel.onDidDispose(() => (ContextPanel.current = undefined));
  }

  private render(): void {
    void this.panel.webview.postMessage({ type: "state", state: this.state });
  }
}
