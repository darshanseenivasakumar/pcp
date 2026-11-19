// Webview CSS + script for the context panel. No vscode import, so dev/preview can render it in a browser.

export const CSS = `
.bar { height: 6px; background: #8883; border-radius: 3px; margin: 6px 0 12px; overflow: hidden; }
.bar > div { height: 100%; background: var(--vscode-progressBar-background, var(--green)); }
.file { cursor: pointer; font-weight: 600; text-decoration: underline dotted; }
.reason { display: inline-block; margin: 2px 4px 2px 0; padding: 0 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: .88em; }
.sym { font-family: var(--vscode-editor-font-family); }
`;

export const SCRIPT = `
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
