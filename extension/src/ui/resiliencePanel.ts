// Resilience panel (B3 / Task C): polls GET /llm/status, breaks the primary model live with
// POST /llm/simulate, and sends a probe through POST /llm/complete to show which model answered
// and how long the failover took.
import * as vscode from "vscode";

import type { VerifierClient } from "../api/client";
import type { LLMResponse, LLMStatus, SimulateMode } from "../contracts";
import { page } from "./webview";

interface Probe {
  time: string;
  modelUsed: string;
  failedOver: boolean;
  failoverMs: number;
  totalMs: number;
  errors: string[];
  source: string;
}

interface ResilienceState {
  status?: LLMStatus;
  error?: string;
  busy?: string;
  probes: Probe[];
}

const CSS = `
.models { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.model { border: 2px solid var(--vscode-panel-border, #8884); border-radius: 8px; padding: 10px; }
.model.active { border-color: var(--green); } .model.broken { border-color: var(--red); }
.big { font-size: 1.6em; font-weight: 700; }
.errors { color: var(--red); font-size: .9em; }
`;

const SCRIPT = `
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

export class ResiliencePanel {
  private static current: ResiliencePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly state: ResilienceState = { probes: [] };
  private timer: NodeJS.Timeout | undefined;

  static show(client: () => VerifierClient): ResiliencePanel {
    if (ResiliencePanel.current) {
      ResiliencePanel.current.panel.reveal();
      return ResiliencePanel.current;
    }
    ResiliencePanel.current = new ResiliencePanel(client);
    return ResiliencePanel.current;
  }

  /** Record a gateway call made elsewhere (e.g. the agent loop) so the panel shows it too. */
  static record(res: Pick<LLMResponse, "model_used" | "failover_ms" | "failed_over" | "errors">, source: string, totalMs = 0): void {
    const p = ResiliencePanel.current;
    if (!p) return;
    p.addProbe(res, source, totalMs);
    void p.poll();
  }

  private constructor(private readonly client: () => VerifierClient) {
    this.panel = vscode.window.createWebviewPanel("pcp.resilience", "PCP: Model resilience", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = page(this.panel.webview, "PCP resilience", CSS, SCRIPT);
    this.panel.webview.onDidReceiveMessage((m: { type: string; mode?: SimulateMode }) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      clearInterval(this.timer);
      ResiliencePanel.current = undefined;
    });
    this.timer = setInterval(() => void this.poll(), 2000);
  }

  private async onMessage(m: { type: string; mode?: SimulateMode }): Promise<void> {
    if (m.type === "ready") return this.poll();
    if (m.type === "simulate" && m.mode) {
      await this.busy("simulate", async () => {
        this.state.status = await this.client().llmSimulate({ primary: m.mode! });
      });
    }
    if (m.type === "probe") {
      await this.busy("probe", async () => {
        const t0 = Date.now();
        const res = await this.client().llmComplete({
          purpose: "resilience_probe",
          messages: [{ role: "user", content: "Reply with the single word: pong" }],
          max_tokens: 5,
        });
        this.addProbe(res, "test prompt", Date.now() - t0);
        this.state.status = await this.client().llmStatus();
      });
    }
  }

  private addProbe(res: Pick<LLMResponse, "model_used" | "failover_ms" | "failed_over" | "errors">, source: string, totalMs: number) {
    this.state.probes.unshift({
      time: new Date().toLocaleTimeString(),
      modelUsed: res.model_used,
      failedOver: !!res.failed_over,
      failoverMs: res.failover_ms,
      totalMs,
      errors: res.errors ?? [],
      source,
    });
    this.state.probes.splice(20);
    this.render();
  }

  private async busy(what: string, fn: () => Promise<void>): Promise<void> {
    this.state.busy = what;
    this.render();
    try {
      await fn();
      this.state.error = undefined;
    } catch (e) {
      this.state.error = (e as Error).message;
    } finally {
      this.state.busy = undefined;
      this.render();
    }
  }

  private async poll(): Promise<void> {
    try {
      this.state.status = await this.client().llmStatus();
      if (!this.state.busy) this.state.error = undefined;
    } catch (e) {
      this.state.error = (e as Error).message;
    }
    this.render();
  }

  private render(): void {
    void this.panel.webview.postMessage({ type: "state", state: this.state });
  }
}
