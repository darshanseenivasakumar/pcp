// Context panel (B1): every file PCP retrieved for the agent and WHY, with its token cost.
import * as vscode from "vscode";

import type { ContextBundle } from "../context/assemble";
import { page } from "./webview";

const CSS = `
.bar { height: 6px; background: #8883; border-radius: 3px; margin: 6px 0 12px; overflow: hidden; }
.bar > div { height: 100%; background: var(--vscode-progressBar-background, var(--green)); }
.file { cursor: pointer; font-weight: 600; text-decoration: underline dotted; }
.reason { display: inline-block; margin: 2px 4px 2px 0; padding: 0 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: .88em; }
.sym { font-family: var(--vscode-editor-font-family); }
`;

const SCRIPT = `
let state = null;
window.addEventListener('message', (e) => { if (e.data.type === 'state') { state = e.data.state; render(); } });
vscode.postMessage({ type: 'ready' });
function render() {
  const b = state.bundle, app = document.getElementById('app');
  const pct = Math.min(100, Math.round(100 * b.totalTokens / Math.max(1, b.budgetTokens)));
  app.replaceChildren(
    h('h1', {}, 'Context sent to the agent'),
    h('div', { class: 'muted' }, state.task),
    h('div', { class: 'row small', style: 'margin-top:6px' },
      h('span', {}, 'Symbols: '), b.symbols.length ? b.symbols.map((s) => h('code', { class: 'sym' }, s + ' ')) : h('span', { class: 'muted' }, 'none'),
      h('span', { class: 'muted' }, '· ' + b.items.length + ' files · ' + b.totalTokens + ' / ' + b.budgetTokens + ' tokens')),
    h('div', { class: 'bar' }, h('div', { style: 'width:' + pct + '%' })),
    h('table', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'File'), h('th', {}, 'Why it was retrieved'), h('th', {}, 'Tokens'), h('th', {}, 'Part')),
      b.items.map((it, i) => h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', {}, h('span', { class: 'file', onclick: () => vscode.postMessage({ type: 'open', file: it.path, line: it.excerpt ? it.excerpt.startLine : 1 }) }, it.path)),
        h('td', {}, it.reasons.map((r) => h('span', { class: 'reason' }, r))),
        h('td', {}, String(it.tokens)),
        h('td', { class: 'muted' }, it.excerpt ? 'lines ' + it.excerpt.startLine + '-' + it.excerpt.endLine : 'whole file')))));
  if (b.dropped.length) {
    app.append(h('h2', {}, 'Relevant but over the token budget'), h('table', {},
      b.dropped.map((d) => h('tr', {}, h('td', {}, d.path), h('td', {}, d.reasons.map((r) => h('span', { class: 'reason' }, r))), h('td', {}, d.tokens + ' tokens')))));
  }
}
`;

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
