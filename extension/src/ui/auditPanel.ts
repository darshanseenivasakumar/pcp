// Audit log view (B4): every tool call and approval, newest first, live.
import * as vscode from "vscode";

import type { AuditLog } from "../mcp/audit";
import { page } from "./webview";

const CSS = `
td.tier { text-align: center; } .t0, .t1 { color: var(--green); } .t2 { color: var(--yellow); } .t3 { color: var(--red); }
.ok { color: var(--green); } .denied, .error { color: var(--red); }
td code { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

const SCRIPT = `
let state = null;
window.addEventListener('message', (e) => { if (e.data.type === 'state') { state = e.data.state; render(); } });
vscode.postMessage({ type: 'ready' });
function render() {
  const app = document.getElementById('app');
  const rows = state.entries.slice().reverse();
  const counts = rows.reduce((m, r) => (m[r.outcome] = (m[r.outcome] || 0) + 1, m), {});
  app.replaceChildren(
    h('h1', {}, 'Tool audit log'),
    h('div', { class: 'muted' }, 'Tiers: 0 read (auto) · 1 shadow write, no disk (auto) · 2 exec (allow-list or approval) · 3 write your files (accepted hunk only)'),
    h('div', { class: 'row small', style: 'margin:6px 0 10px' },
      h('span', {}, rows.length + ' calls'), h('span', { class: 'ok' }, (counts.ok || 0) + ' ok'),
      h('span', { class: 'denied' }, (counts.denied || 0) + ' denied'), h('span', { class: 'error' }, (counts.error || 0) + ' errors'),
      state.mcpUrl ? h('span', { class: 'muted' }, 'MCP server: ' + state.mcpUrl) : null),
    h('table', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Tool'), h('th', {}, 'Tier'), h('th', {}, 'Arguments'), h('th', {}, 'Approved by'), h('th', {}, 'Outcome'), h('th', {}, 'ms'), h('th', {}, 'From')),
      rows.map((r) => h('tr', {},
        h('td', {}, new Date(r.time).toLocaleTimeString()), h('td', {}, h('strong', {}, r.tool)),
        h('td', { class: 'tier t' + r.tier }, String(r.tier)), h('td', {}, h('code', {}, r.args)),
        h('td', {}, r.approvedBy), h('td', { class: r.outcome }, r.outcome + (r.detail ? ': ' + r.detail : '')),
        h('td', {}, String(r.durationMs)), h('td', { class: 'muted' }, r.source)))));
}
`;

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
