// Webview CSS + script for the review panel. No vscode import, so dev/preview can render it in a browser.

export const CSS = `
.header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.score { text-align: center; min-width: 120px; border-radius: 8px; padding: 6px 10px; color: #fff; }
.score .num { font-size: 2em; font-weight: 700; line-height: 1.1; } .score .lbl { font-weight: 700; letter-spacing: .04em; }
.history { font-weight: 600; } .history .arrow { color: var(--muted); padding: 0 4px; }
.stages { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.stage { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 6px 8px; }
.stage .name { font-weight: 600; } .stage .msg { color: var(--muted); font-size: .9em; min-height: 1.3em; overflow-wrap: anywhere; }
.st-pending .icon::before { content: "○"; color: var(--muted); }
.st-started .icon::before { content: "◌"; color: var(--yellow); display: inline-block; animation: spin 1s linear infinite; }
.st-done .icon::before { content: "●"; color: var(--green); } .st-failed .icon::before { content: "✕"; color: var(--red); }
@keyframes spin { to { transform: rotate(360deg); } }
.log { max-height: 150px; overflow-y: auto; font-family: var(--vscode-editor-font-family); font-size: .85em; }
.log .error { color: var(--red); } .log .agent { color: var(--vscode-textLink-foreground); }
.hunk-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.hunk-file { font-weight: 600; cursor: pointer; text-decoration: underline dotted; }
.diff { border-radius: 4px; margin-top: 6px; background: var(--vscode-textCodeBlock-background, #8881); padding: 4px 0;
  font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); overflow-x: auto; }
.diff div { white-space: pre; padding: 0 8px; } .diff .add { background: #2ea04326; } .diff .del { background: #da363326; }
.diff .ctx { color: var(--muted); }
.ev { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; font-size: .92em; }
.finding { border-left: 3px solid var(--yellow); padding-left: 8px; margin: 4px 0; } .finding.critical { border-color: var(--red); }
.state-accepted { border-color: var(--green); } .state-rejected { opacity: .55; }
.reason { padding: 8px 10px; border-radius: 6px; border: 1px solid; margin-top: 8px; }
.note { margin-top: 18px; }
@media (max-width: 700px) { .stages { grid-template-columns: 1fr 1fr; } .ev { grid-template-columns: 1fr; } }
`;

export const SCRIPT = `
let state = null;
window.addEventListener('message', (e) => { if (e.data.type === 'state') { state = e.data.state; render(); } });
vscode.postMessage({ type: 'ready' });
const outcomeClass = (o) => o === 'passed' ? 'green' : o === 'failed' || o === 'error' ? 'red' : 'muted';
const resultClass = (r) => r === 'pass' ? 'green' : r === 'fail' ? 'red' : 'yellow';

function render() {
  const s = state, v = s.verdict, app = document.getElementById('app');
  app.replaceChildren();
  // header
  const left = h('div', {},
    h('h1', {}, s.title),
    h('div', { class: 'muted' }, s.task),
    h('div', { class: 'row small', style: 'margin-top:6px' },
      h('span', { class: 'pill' }, s.mode === 'inline' ? 'Inline edit' : s.mode === 'agent' ? 'Agent mode' : 'Diff'),
      h('span', {}, 'Agent: ' + s.backend),
      s.attempt ? h('span', {}, 'Attempt ' + s.attempt + ' of ' + s.maxAttempts) : null,
      s.model && s.model.used ? h('span', { class: s.model.failedOver ? 'amber' : '' },
        'Model: ' + s.model.used + (s.model.failedOver ? ' (primary failed, failover ' + s.model.failoverMs + ' ms)' : '')) : null),
    h('div', { class: 'row', style: 'margin-top:8px' },
      s.running ? h('button', { class: 'danger', onclick: () => vscode.postMessage({ type: 'cancel' }) }, 'Cancel') : null,
      v && s.canAccept ? h('button', { class: 'secondary', onclick: () => vscode.postMessage({ type: 'acceptAll' }) }, 'Accept all pending hunks') : null));
  const right = v ? h('div', { class: 'score bg-' + v.badge },
    h('div', { class: 'num' }, String(v.score)), h('div', { class: 'lbl' }, v.badgeText),
    h('div', { class: 'small' }, v.decision)) : h('div', { class: 'score', style: 'background:#8884' }, h('div', { class: 'lbl' }, s.running ? 'VERIFYING…' : '—'));
  app.append(h('div', { class: 'header' }, left, right));

  if (v && v.history.length) {
    const hist = h('div', { class: 'history row', style: 'margin-top:8px' }, h('span', { class: 'muted' }, 'Score history:'));
    v.history.forEach((x, i) => { if (i) hist.append(h('span', { class: 'arrow' }, '→')); hist.append(h('span', {}, String(x))); });
    app.append(hist);
  }

  // stages
  app.append(h('h2', {}, 'Verification stages'));
  app.append(h('div', { class: 'stages' }, s.stages.map((st) =>
    h('div', { class: 'stage st-' + st.status }, h('div', { class: 'name' }, h('span', { class: 'icon' }), ' ', st.label), h('div', { class: 'msg' }, st.message)))));
  if (s.log.length) app.append(h('div', { class: 'card log' }, s.log.map((l) => h('div', { class: l.kind }, l.time + '  ' + l.text))));

  if (s.outcome) {
    const cls = { review: 'green', blocked: 'red', gave_up: 'amber', cancelled: 'yellow', failed: 'red' }[s.outcome.status] || '';
    app.append(h('div', { class: 'reason ' + cls }, h('strong', {}, s.outcome.message)));
  }
  if (!v) return;

  // verdict
  app.append(h('h2', {}, 'Verdict'));
  app.append(h('div', { class: 'reason ' + v.badge }, h('strong', {}, v.decision + ': '), v.reason));
  app.append(h('div', { class: 'card' }, md(v.summaryMd)));
  if (v.decision === 'REPAIR' && v.repairInstructions) app.append(h('details', { class: 'card' }, h('summary', {}, 'Repair instructions sent to the agent'), h('pre', {}, v.repairInstructions)));
  if (v.proof) {
    const p = v.proof;
    app.append(h('div', { class: 'card small' },
      h('div', {}, h('strong', {}, 'Proof '), '(' + p.sandbox + '): ',
        h('span', { class: p.f2pOk ? 'green' : 'red' }, 'F2P ' + (p.f2pOk ? 'ok' : 'failed')), ' · ',
        h('span', { class: p.p2pOk ? 'green' : 'red' }, 'P2P ' + (p.p2pOk ? 'ok' : 'failed'))),
      p.baseline ? h('div', {}, 'Old code: ' + p.baseline) : null,
      p.patched ? h('div', {}, 'New code: ' + p.patched) : null,
      p.tampering.length ? h('div', { class: 'red' }, 'Tampering: ' + p.tampering.join('; ')) : null,
      p.error ? h('div', { class: 'red' }, p.error) : null));
  }
  app.append(h('table', {}, h('tr', {}, h('th', {}, 'Checker'), h('th', {}, 'Status'), h('th', {}, 'Risk'), h('th', {}, 'Findings'), h('th', {}, 'Recommended action')),
    v.checks.map((c) => h('tr', {}, h('td', {}, c.checker),
      h('td', { class: c.status === 'pass' ? 'green' : c.status === 'critical' ? 'red' : 'yellow' }, c.status),
      h('td', {}, String(c.risk)), h('td', {}, String(c.findings)), h('td', {}, c.action)))));

  // hunks
  app.append(h('h2', {}, 'Hunks (' + s.hunks.length + ')'));
  for (const hk of s.hunks) {
    const pending = hk.state === 'pending';
    const head = h('div', { class: 'hunk-head' },
      h('div', { class: 'row' }, h('strong', {}, hk.id),
        h('span', { class: 'hunk-file', onclick: () => vscode.postMessage({ type: 'open', file: hk.file, line: Number((/\\+(\\d+)/.exec(hk.header) || [])[1] || 1) }) }, hk.file),
        h('span', { class: 'pill ' + resultClass(hk.result) }, 'tests: ' + hk.result),
        hk.state !== 'pending' ? h('span', { class: 'pill ' + (hk.state === 'accepted' ? 'green' : 'muted') }, hk.state) : null),
      h('div', { class: 'row' },
        h('button', { disabled: !(pending && s.canAccept), onclick: () => vscode.postMessage({ type: 'accept', id: hk.id }) }, 'Accept'),
        h('button', { class: 'secondary', disabled: !pending, onclick: () => vscode.postMessage({ type: 'reject', id: hk.id }) }, 'Reject')));
    const diff = h('div', { class: 'diff' }, h('div', { class: 'ctx' }, hk.header),
      hk.lines.map((l) => h('div', { class: l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx' }, l.kind + l.text)));
    const tests = h('div', {}, h('div', { class: 'muted' }, 'Tests covering this hunk'),
      hk.tests.length ? hk.tests.map((t) => h('div', {}, h('span', { class: outcomeClass(t.outcome) }, (t.outcome || 'not run') + ' '),
        t.baseline ? h('span', { class: 'muted' }, '(old: ' + t.baseline + ') ') : null, h('code', {}, t.id),
        t.cases > 1 ? h('span', { class: 'muted' }, ' · ' + t.cases + ' cases') : null)) : h('div', { class: 'muted' }, 'none'));
    const findings = h('div', {}, h('div', { class: 'muted' }, 'Findings'),
      hk.findings.length ? hk.findings.map((f) => h('div', { class: 'finding' + (f.type === 'secret' || f.type === 'tampering' ? ' critical' : '') },
        h('div', {}, h('strong', {}, f.checker + ' · ' + f.type), ' ', h('span', { class: 'muted' }, '(' + f.source + ', ' + Math.round(f.confidence * 100) + '%' + (f.validated !== 'not_required' ? ', ' + f.validated : '') + ')')),
        h('div', {}, f.message),
        f.file ? h('div', { class: 'muted small' }, f.file + (f.line_start ? ':' + f.line_start : '')) : null,
        f.evidence ? h('pre', { class: 'small' }, f.evidence) : null)) : h('div', { class: 'muted' }, 'none'));
    app.append(h('div', { class: 'card state-' + hk.state }, head, hk.error ? h('div', { class: 'red' }, hk.error) : null, diff, h('div', { class: 'ev' }, tests, findings)));
  }
  app.append(h('div', { class: 'note muted small' }, s.canAccept
    ? 'Nothing is written until you accept a hunk. Accept writes only that hunk; Reject writes nothing.'
    : 'Accept is disabled: only a REVIEW verdict can reach your files.'));
}
`;
