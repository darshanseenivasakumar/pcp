// HTTP client for the PCP verifier (AGENTS.md section 4.4). Every call has a timeout,
// every response is validated against contracts/, and an unreachable verifier produces
// one clear, actionable error instead of a stack trace.
import type {
  Health,
  LLMRequest,
  LLMResponse,
  LLMSimulateRequest,
  LLMStatus,
  PcpEvent,
  Verdict,
  VerifyRequest,
  VerifyResponse,
} from "../contracts";
import { parseContract } from "../contracts";
import { SseParser } from "./sse";

export interface VerifierClientOptions {
  baseUrl: string;
  /** Per-request timeout for ordinary calls (not the SSE stream). */
  timeoutMs?: number;
  /** Timeout for /llm/complete, which may wait for a primary model to fail over. */
  llmTimeoutMs?: number;
  /** SSE reconnect attempts before the caller falls back to polling. */
  sseMaxRetries?: number;
  sseRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export class VerifierOfflineError extends Error {
  constructor(
    readonly baseUrl: string,
    cause?: unknown,
  ) {
    super(
      `PCP verifier is not reachable at ${baseUrl}. Start it with scripts/dev.sh ` +
        `(Windows: powershell scripts/dev.ps1), or run the mock with "npm run mock" in extension/.`,
    );
    this.name = "VerifierOfflineError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export class VerifierTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`PCP verifier did not answer ${what} within ${ms} ms.`);
    this.name = "VerifierTimeoutError";
  }
}

export class VerifierHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`PCP verifier returned HTTP ${status} for ${what}: ${body.slice(0, 300)}`);
    this.name = "VerifierHttpError";
  }
}

export class CancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** The verdict is not ready yet (server answered 202 / 404-while-running). */
const PENDING = Symbol("pending");

/** SSE `event:` names that carry a PcpEvent. Anything else on the stream is ignored. */
const EVENT_NAMES = new Set(["proof", "checks", "validate", "verdict", "message", "pcp", "event"]);

function isTerminal(e: PcpEvent): boolean {
  return e.stage === "verdict" && (e.status === "done" || e.status === "failed");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new CancelledError());
      },
      { once: true },
    );
  });

export class VerifierClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly llmTimeoutMs: number;
  private readonly sseMaxRetries: number;
  private readonly sseRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: VerifierClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.llmTimeoutMs = opts.llmTimeoutMs ?? 90_000;
    this.sseMaxRetries = opts.sseMaxRetries ?? 5;
    this.sseRetryDelayMs = opts.sseRetryDelayMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  health(signal?: AbortSignal): Promise<Health> {
    return this.json("GET", "/health", undefined, "health", signal);
  }

  async verify(req: VerifyRequest, signal?: AbortSignal): Promise<VerifyResponse> {
    parseContract("verify_request", req); // fail before sending a malformed request
    return this.json("POST", "/verify", req, "verify_response", signal);
  }

  async getVerdict(patchId: string, signal?: AbortSignal): Promise<Verdict | null> {
    const res = await this.request("GET", `/verify/${encodeURIComponent(patchId)}`, undefined, signal);
    if (res === PENDING) return null;
    return parseContract("verdict", await res.json());
  }

  async cancel(patchId: string, signal?: AbortSignal): Promise<void> {
    const res = await this.request("POST", `/verify/${encodeURIComponent(patchId)}/cancel`, {}, signal);
    if (res !== PENDING) await res.body?.cancel();
  }

  llmComplete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    parseContract("llm_request", req);
    return this.json("POST", "/llm/complete", req, "llm_response", signal, this.llmTimeoutMs);
  }

  /** Task C: which models are configured, which one answered last, and the last failover time. */
  llmStatus(signal?: AbortSignal): Promise<LLMStatus> {
    return this.json("GET", "/llm/status", undefined, "llm_status", signal);
  }

  /** Task C demo switch: make the primary model fail / hang / recover, live. */
  llmSimulate(req: LLMSimulateRequest, signal?: AbortSignal): Promise<LLMStatus> {
    parseContract("llm_simulate_request", req);
    return this.json("POST", "/llm/simulate", req, "llm_status", signal);
  }

  /** Polls GET /verify/{id} until the verdict exists. Used when SSE is unavailable. */
  async waitForVerdict(
    patchId: string,
    opts: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number } = {},
  ): Promise<Verdict> {
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    for (;;) {
      const v = await this.getVerdict(patchId, opts.signal);
      if (v) return v;
      if (Date.now() > deadline) throw new VerifierTimeoutError(`a verdict for ${patchId}`, opts.timeoutMs ?? 600_000);
      await sleep(opts.pollMs ?? 500, opts.signal);
    }
  }

  /**
   * Streams progress events. Reconnects (sending Last-Event-ID) when the connection drops before
   * the verdict event. The verifier replays the whole run to every new subscriber, so events
   * are de-duplicated by their numeric SSE id (or by position if a server sends no ids).
   * Ends after the terminal verdict event, or after `sseMaxRetries` failed reconnects (callers
   * then fall back to `waitForVerdict`).
   */
  async *events(patchId: string, signal?: AbortSignal): AsyncGenerator<PcpEvent> {
    const parser = new SseParser();
    let seen = 0;
    let maxId = -Infinity;
    let failures = 0;
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      parser.resetPartial();
      let deliveredThisConnection = 0;
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (parser.lastEventId !== undefined) headers["last-event-id"] = parser.lastEventId;
        const res = await this.fetchImpl(`${this.baseUrl}/verify/${encodeURIComponent(patchId)}/events`, {
          headers,
          signal,
        });
        if (!res.ok || !res.body) {
          throw new VerifierHttpError(res.status, await res.text().catch(() => ""), "events");
        }
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let skip = seen; // only used for id-less events
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const msg of parser.feed(decoder.decode(value, { stream: true }))) {
            if (!EVENT_NAMES.has(msg.event)) continue; // e.g. "ping" keep-alives
            const id = msg.id !== undefined && /^\d+$/.test(msg.id) ? Number(msg.id) : undefined;
            if (id !== undefined) {
              if (id <= maxId) continue; // replayed on reconnect
              maxId = id;
            } else if (skip > 0) {
              skip--;
              continue;
            }
            const ev = parseContract("event", JSON.parse(msg.data));
            seen++;
            deliveredThisConnection++;
            failures = 0;
            yield ev;
            if (isTerminal(ev)) {
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) throw new CancelledError();
        if (err instanceof VerifierHttpError && err.status === 404) throw err;
        if (err instanceof SyntaxError || (err as Error).name === "ContractError") throw err;
      }
      // Stream ended (or broke) without a verdict event: reconnect.
      if (deliveredThisConnection === 0) failures++;
      if (failures > this.sseMaxRetries) return;
      await sleep(parser.retryMs ?? this.sseRetryDelayMs, signal);
    }
  }

  // ------------------------------------------------------------------ internals
  private async json<K extends "health" | "verify_response" | "llm_response" | "llm_status">(
    method: string,
    path: string,
    body: unknown,
    contract: K,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) {
    const res = await this.request(method, path, body, signal, timeoutMs);
    if (res === PENDING) throw new VerifierHttpError(202, "", `${method} ${path}`);
    return parseContract(contract, await res.json());
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<Response | typeof PENDING> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      if (timeout.aborted) throw new VerifierTimeoutError(`${method} ${path}`, timeoutMs);
      throw new VerifierOfflineError(this.baseUrl, err);
    }
    if (res.status === 202) {
      await res.body?.cancel();
      return PENDING;
    }
    if (!res.ok) {
      throw new VerifierHttpError(res.status, await res.text().catch(() => ""), `${method} ${path}`);
    }
    return res;
  }
}
