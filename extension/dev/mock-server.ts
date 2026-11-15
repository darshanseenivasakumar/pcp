// Mock PCP verifier (AGENTS.md 7.1 step 1). Serves the contracts/examples/ verdicts and streams
// fake events over SSE so the extension works before Person 1's server exists. Every response
// it sends is validated against contracts/ first, so the mock can't drift from the real shapes.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";

import type { Health, LLMResponse, PcpEvent, Verdict } from "../src/contracts";
import { parseContract } from "../src/contracts";

import eventsExample from "../../contracts/examples/events_stream.json";
import healthExample from "../../contracts/examples/health.json";
import blockExample from "../../contracts/examples/verdict_block.json";
import repairExample from "../../contracts/examples/verdict_repair.json";
import reviewExample from "../../contracts/examples/verdict_review.json";
import unprovenExample from "../../contracts/examples/verdict_review_unproven.json";

export type MockScenario = "auto" | "review" | "repair" | "block" | "unproven" | "always-repair";

export interface MockOptions {
  port?: number; // 0 = pick a free port
  host?: string;
  /** auto: secret -> BLOCK, no test change -> unproven REVIEW, attempt 1 -> REPAIR, later -> REVIEW. */
  scenario?: MockScenario;
  eventDelayMs?: number;
  /** /llm/complete pretends the primary model is down and fails over to a backup. */
  primaryDown?: boolean;
  primaryFailMs?: number;
  /** Drop the first SSE connection after this many events (exercises client reconnect). */
  dropSseAfter?: number;
  healthDelayMs?: number;
  /** Serve a verdict that breaks the contracts (exercises loud client-side validation). */
  invalidVerdict?: boolean;
  /** Repo root, to find fixtures/tiny_repo/diffs for the mock LLM. Auto-detected if omitted. */
  repoRoot?: string;
}

export interface MockRun {
  patchId: string;
  request: { task: string; diff: string; attempt: number; previous_patch_id?: string | null };
  planned: PcpEvent[];
  emitted: PcpEvent[];
  verdict: Verdict;
  cancelled: boolean;
  timer?: NodeJS.Timeout;
  listeners: Set<() => void>;
}

export interface MockServer {
  url: string;
  runs: Map<string, MockRun>;
  llmCalls: { purpose: string; failedOver: boolean }[];
  close(): Promise<void>;
}

const SECRET_RE = /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const TEST_FILE_RE = /^\+\+\+ b\/(.*\/)?(tests?\/|test_[^/]*\.py$|[^/]*_test\.py$)/m;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "contracts", "types.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function countHunks(diff: string): number {
  return (diff.match(/^@@ /gm) ?? []).length;
}

export function pickVerdict(
  scenario: MockScenario,
  diff: string,
  attempt: number,
): "review" | "repair" | "block" | "unproven" {
  if (scenario === "always-repair") return "repair";
  if (scenario !== "auto") return scenario;
  if (SECRET_RE.test(diff)) return "block";
  if (!TEST_FILE_RE.test(diff)) return "unproven";
  return attempt <= 1 ? "repair" : "review";
}

function buildVerdict(
  kind: "review" | "repair" | "block" | "unproven",
  patchId: string,
  attempt: number,
  diff: string,
  previous?: MockRun,
): Verdict {
  const base = { review: reviewExample, repair: repairExample, block: blockExample, unproven: unprovenExample }[kind];
  const v = clone(base) as Verdict;
  v.patch_id = patchId;
  v.attempt = attempt;
  if (v.proof) v.proof.attempt = attempt;
  v.score_history = [...(previous?.verdict.score_history ?? []), v.score];
  v.created_at = new Date().toISOString();
  if (v.decision === "REPAIR") {
    v.repair_instructions = (v.repair_instructions ?? "").replace(/attempt \d of 3/, `attempt ${attempt + 1} of 3`);
    v.decision_reason = `score ${v.score} is in the repair band (40-69), attempt ${attempt} of 3`;
  }
  // Re-key hunk evidence onto the real hunks of the submitted diff (h1..hN, diff order).
  const template = Object.values(v.hunk_evidence ?? {});
  const evidence: NonNullable<Verdict["hunk_evidence"]> = {};
  const n = countHunks(diff);
  for (let i = 0; i < n; i++) {
    const t = template[Math.min(i, template.length - 1)];
    evidence[`h${i + 1}`] = t ? clone(t) : { tests: [], result: "untested", findings: [] };
  }
  v.hunk_evidence = evidence;
  return parseContract("verdict", v);
}

function buildEvents(patchId: string, v: Verdict): PcpEvent[] {
  const events = clone(eventsExample as PcpEvent[]).map((e) => ({ ...e, patch_id: patchId }));
  const last = events[events.length - 1];
  if (last) {
    last.message = `${v.decision}, score ${v.score}`;
    last.data = { decision: v.decision, score: v.score };
  }
  return events.map((e) => parseContract("event", e));
}

async function readBody(req: IncomingMessage, limit = 5_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const scenario = opts.scenario ?? "auto";
  const eventDelayMs = opts.eventDelayMs ?? 400;
  const repoRoot = opts.repoRoot ?? findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname);
  const runs = new Map<string, MockRun>();
  const llmCalls: MockServer["llmCalls"] = [];
  let sseConnections = 0;

  function emitNext(run: MockRun): void {
    const next = run.planned[run.emitted.length];
    if (!next || run.cancelled) return;
    run.emitted.push(next);
    for (const l of run.listeners) l();
    if (run.emitted.length < run.planned.length) run.timer = setTimeout(() => emitNext(run), eventDelayMs);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      if (opts.healthDelayMs) await sleep(opts.healthDelayMs);
      return send(res, 200, parseContract("health", healthExample as Health));
    }

    if (req.method === "POST" && url.pathname === "/verify") {
      const body = parseContract("verify_request", await readBody(req));
      const patchId = randomUUID();
      const attempt = body.attempt ?? 1;
      const previous = body.previous_patch_id ? runs.get(body.previous_patch_id) : undefined;
      const verdict = buildVerdict(pickVerdict(scenario, body.diff, attempt), patchId, attempt, body.diff, previous);
      const run: MockRun = {
        patchId,
        request: { ...body, attempt },
        planned: buildEvents(patchId, verdict),
        emitted: [],
        verdict,
        cancelled: false,
        listeners: new Set(),
      };
      runs.set(patchId, run);
      run.timer = setTimeout(() => emitNext(run), eventDelayMs);
      return send(res, 200, parseContract("verify_response", { patch_id: patchId }));
    }

    if (parts[0] === "verify" && parts[1]) {
      const run = runs.get(parts[1]);
      if (!run) return send(res, 404, { detail: "unknown patch_id" });

      if (req.method === "GET" && parts.length === 2) {
        if (run.cancelled) return send(res, 409, { detail: "cancelled" });
        if (run.emitted.length < run.planned.length) return send(res, 202, { status: "running" });
        if (opts.invalidVerdict) return send(res, 200, { ...run.verdict, decision: "MAYBE" });
        return send(res, 200, run.verdict);
      }

      if (req.method === "POST" && parts[2] === "cancel") {
        if (!run.cancelled && run.emitted.length < run.planned.length) {
          run.cancelled = true;
          clearTimeout(run.timer);
          const stage = run.planned[run.emitted.length]?.stage ?? "proof";
          run.emitted.push(
            { patch_id: run.patchId, stage, status: "failed", message: "Cancelled by user; sandbox killed", data: {} },
            { patch_id: run.patchId, stage: "verdict", status: "failed", message: "Cancelled", data: { cancelled: true } },
          );
          for (const l of run.listeners) l();
        }
        return send(res, 200, { patch_id: run.patchId, cancelled: run.cancelled });
      }

      if (req.method === "GET" && parts[2] === "events") {
        const connection = ++sseConnections;
        const lastId = Number(req.headers["last-event-id"] ?? -1);
        let next = Number.isFinite(lastId) ? lastId + 1 : 0;
        let sentThisConnection = 0;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const flush = () => {
          while (next < run.emitted.length) {
            const ev = run.emitted[next]!;
            res.write(`id: ${next}\ndata: ${JSON.stringify(ev)}\n\n`);
            next++;
            sentThisConnection++;
            if (opts.dropSseAfter && connection === 1 && sentThisConnection >= opts.dropSseAfter) {
              run.listeners.delete(flush);
              res.socket?.destroy();
              return;
            }
            if (ev.stage === "verdict" && (ev.status === "done" || ev.status === "failed")) {
              run.listeners.delete(flush);
              res.end();
              return;
            }
          }
        };
        run.listeners.add(flush);
        req.on("close", () => run.listeners.delete(flush));
        flush();
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/llm/complete") {
      const body = parseContract("llm_request", await readBody(req));
      const started = Date.now();
      const errors: string[] = [];
      if (opts.primaryDown) {
        await sleep(opts.primaryFailMs ?? 300);
        errors.push("primary: HTTP 503 Service Unavailable (simulated)", "primary retry: HTTP 503 (simulated)");
      }
      const out: LLMResponse = {
        text: mockCompletion(body.purpose, body.messages.map((m) => m.content).join("\n"), repoRoot),
        model_used: opts.primaryDown ? "secondary:mock-backup" : "primary:mock-model",
        failover_ms: opts.primaryDown ? Date.now() - started : 0,
        failed_over: !!opts.primaryDown,
        errors,
      };
      llmCalls.push({ purpose: body.purpose, failedOver: !!opts.primaryDown });
      return send(res, 200, parseContract("llm_response", out));
    }

    send(res, 404, { detail: `no route ${req.method} ${url.pathname}` });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 422, { detail: String((err as Error).message ?? err) });
      else res.end();
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    runs,
    llmCalls,
    close: () =>
      new Promise<void>((r) => {
        for (const run of runs.values()) clearTimeout(run.timer);
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Mock model: answers agent prompts with the tiny_repo fixture diffs (fixable first, then the fix). */
function mockCompletion(purpose: string, prompt: string, repoRoot: string | undefined): string {
  if (!purpose.startsWith("agent")) return '{"verdict": "confirm", "confidence": 0.9}';
  const name = /Fix these and resubmit|attempt [23] of 3/.test(prompt) ? "fixable_v2.diff" : "fixable.diff";
  const path = repoRoot ? join(repoRoot, "fixtures", "tiny_repo", "diffs", name) : "";
  if (!path || !existsSync(path)) return "I could not produce a diff (mock fixtures not found).";
  return "Here is the patch.\n\n```diff\n" + readFileSync(path, "utf8") + "```\n";
}
