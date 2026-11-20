// Resilience panel (B3 / Task C): polls GET /llm/status, breaks the primary model live with
// POST /llm/simulate, and sends a probe through POST /llm/complete to show which model answered
// and how long the failover took.
import * as vscode from "vscode";

import type { VerifierClient } from "../api/client";
import type { LLMResponse, LLMStatus, SimulateMode } from "../contracts";
import { CSS, SCRIPT } from "./views/resilience";
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

  /**
   * Demo playback: break the primary model, send a test prompt (the backup answers), then restore
   * the primary so the next take starts healthy. Same actions as the panel's buttons.
   */
  static async play(client: () => VerifierClient, pauseMs: number): Promise<void> {
    const p = ResiliencePanel.show(client);
    const wait = () => new Promise((r) => setTimeout(r, pauseMs));
    await p.poll();
    await wait();
    await p.onMessage({ type: "simulate", mode: "fail" });
    await wait();
    await p.onMessage({ type: "probe" });
    await wait();
    await wait();
    await p.onMessage({ type: "simulate", mode: "ok" });
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
