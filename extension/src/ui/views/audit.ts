// Webview CSS + script for the audit panel. No vscode import, so dev/preview can render it in a browser.

export const CSS = `
td.tier { text-align: center; } .t0, .t1 { color: var(--green); } .t2 { color: var(--yellow); } .t3 { color: var(--red); }
.ok { color: var(--green); } .denied, .error { color: var(--red); }
td code { white-space: pre-wrap; overflow-wrap: anywhere; }
`;

export const SCRIPT = `
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
