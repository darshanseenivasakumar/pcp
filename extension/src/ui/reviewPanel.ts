// Review panel (B2 + A3): live stages from SSE, Cancel, score badge + history, summary,
// and the diff split into hunks with Accept/Reject and each hunk's tests and findings.
import * as vscode from "vscode";

import type { ReviewViewState } from "./reviewState";
import { CSS, SCRIPT } from "./views/review";
import { page } from "./webview";

export type ReviewMessage =
  | { type: "accept"; id: string }
  | { type: "reject"; id: string }
  | { type: "acceptAll" }
  | { type: "cancel" }
  | { type: "open"; file: string; line?: number }
  | { type: "ready" };

export class ReviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  constructor(
    title: string,
    private readonly getState: () => ReviewViewState,
    onMessage: (m: ReviewMessage) => void,
  ) {
    this.panel = vscode.window.createWebviewPanel("pcp.review", title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = page(this.panel.webview, "PCP review", CSS, SCRIPT);
    this.panel.webview.onDidReceiveMessage((m: ReviewMessage) => {
      if (m.type === "ready") this.refresh();
      else onMessage(m);
    });
    this.panel.onDidDispose(() => (this.disposed = true));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  refresh(): void {
    if (!this.disposed) void this.panel.webview.postMessage({ type: "state", state: this.getState() });
  }

  reveal(): void {
    if (!this.disposed) this.panel.reveal(undefined, true);
  }

  onDispose(fn: () => void): void {
    this.panel.onDidDispose(fn);
  }
}
