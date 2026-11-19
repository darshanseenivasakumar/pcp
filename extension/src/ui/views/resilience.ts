// Webview CSS + script for the resilience panel. No vscode import, so dev/preview can render it in a browser.

export const CSS = `
.models { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.model { border: 2px solid var(--vscode-panel-border, #8884); border-radius: 8px; padding: 10px; }
.model.active { border-color: var(--green); } .model.broken { border-color: var(--red); }
.big { font-size: 1.6em; font-weight: 700; }
.errors { color: var(--red); font-size: .9em; }
`;

export const SCRIPT = `
let state = null;
window.addEventListener('message', (e) => { if (e.data.type === 'state') { state = e.data.state; render(); } });
vscode.postMessage({ type: 'ready' });
const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
function render() {
  const s = state, st = s.status, app = document.getElementById('app');
  app.replaceChildren(h('h1', {}, 'Model resilience (Task C)'),
    h('div', { class: 'muted' }, 'Primary model -> retry once -> secondary. The verifier gateway fails over automatically; this panel breaks the primary on purpose to prove it.'));
  if (s.error) app.append(h('div', { class: 'card red' }, s.error));
  if (!st) return;
  if (!st.configured) { app.append(h('div', { class: 'card yellow' }, 'No model configured on the verifier (set PCP_PRIMARY_* / PCP_SECONDARY_*).')); return; }
  const used = st.last_model_used || '';
  app.append(h('h2', {}, 'Models'), h('div', { class: 'models' }, (st.models || []).map((m) => {
    const broken = m.simulated && m.simulated !== 'ok';
    const active = used === m.role + ':' + m.name;
    return h('div', { class: 'model' + (active ? ' active' : '') + (broken ? ' broken' : '') },
      h('div', { class: 'muted' }, m.role), h('div', { class: 'big' }, m.name),
      h('div', {}, broken ? h('span', { class: 'pill red' }, 'simulated: ' + m.simulated) : h('span', { class: 'pill green' }, 'healthy')),
      active ? h('div', { class: 'green', style: 'margin-top:4px' }, 'answered last') : null);
  })));
  app.append(h('div', { class: 'card' },
    h('div', {}, 'Last model used: ', h('strong', {}, used || '—')),
    h('div', {}, 'Last failover: ', h('strong', { class: st.last_failover_ms ? 'amber' : '' }, st.last_failover_ms === null || st.last_failover_ms === undefined ? '—' : st.last_failover_ms + ' ms'))));
  const primary = (st.models || []).find((m) => m.role === 'primary');
  const mode = primary && primary.simulated || 'ok';
  app.append(h('div', { class: 'row', style: 'margin-top:8px' },
    h('button', { class: 'danger', disabled: !!s.busy || mode === 'fail', onclick: () => send('simulate', { mode: 'fail' }) }, 'Break primary model (HTTP 503)'),
    h('button', { class: 'secondary', disabled: !!s.busy || mode === 'timeout', onclick: () => send('simulate', { mode: 'timeout' }) }, 'Make primary hang (timeout)'),
    h('button', { class: 'secondary', disabled: !!s.busy || mode === 'ok', onclick: () => send('simulate', { mode: 'ok' }) }, 'Restore primary'),
    h('button', { disabled: !!s.busy, onclick: () => send('probe') }, s.busy === 'probe' ? 'Asking the model…' : 'Send a test prompt')));
  if (s.probes.length) {
    app.append(h('h2', {}, 'Calls through the gateway'), h('table', {},
      h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'From'), h('th', {}, 'Answered by'), h('th', {}, 'Failover'), h('th', {}, 'Total'), h('th', {}, 'What failed')),
      s.probes.map((p) => h('tr', {}, h('td', {}, p.time), h('td', {}, p.source),
        h('td', { class: p.failedOver ? 'amber' : 'green' }, p.modelUsed),
        h('td', {}, p.failedOver ? p.failoverMs + ' ms' : '—'), h('td', {}, p.totalMs + ' ms'),
        h('td', { class: 'errors' }, p.errors.join(' | '))))));
  }
}
`;
