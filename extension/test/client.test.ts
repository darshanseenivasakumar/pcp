import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MockOptions, MockServer } from "../dev/mock-server";
import { startMockServer } from "../dev/mock-server";
import {
  CancelledError,
  VerifierClient,
  VerifierOfflineError,
  VerifierTimeoutError,
} from "../src/api/client";
import type { PcpEvent } from "../src/contracts";
import { ContractError } from "../src/contracts";

const DIFFS = join(__dirname, "..", "..", "fixtures", "tiny_repo", "diffs");
const diff = (name: string) => readFileSync(join(DIFFS, name), "utf8");
const TASK = 'Make parse_bool also treat "on" as true.';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(opts: MockOptions = {}) {
  server = await startMockServer({ eventDelayMs: 5, ...opts });
  return new VerifierClient({ baseUrl: server.url, timeoutMs: 2000, sseRetryDelayMs: 10 });
}

async function collect(it: AsyncIterable<PcpEvent>): Promise<PcpEvent[]> {
  const out: PcpEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("VerifierClient against the mock server", () => {
  it("health", async () => {
    const c = await setup();
    expect((await c.health()).status).toBe("ok");
  });

  it("verify -> stream events -> verdict (fixable then fixed)", async () => {
    const c = await setup();
    const first = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("fixable.diff"), attempt: 1 });
    const events = await collect(c.events(first.patch_id));
    expect(events.map((e) => e.stage)).toEqual(["proof", "proof", "proof", "proof", "checks", "checks", "checks", "validate", "verdict"]);
    const v1 = await c.waitForVerdict(first.patch_id, { pollMs: 5 });
    expect(v1.decision).toBe("REPAIR");
    expect(Object.keys(v1.hunk_evidence ?? {})).toEqual(["h1", "h2"]);

    const second = await c.verify({
      task: TASK,
      repo_root: "/repo",
      diff: diff("fixable_v2.diff"),
      attempt: 2,
      previous_patch_id: first.patch_id,
    });
    await collect(c.events(second.patch_id));
    const v2 = await c.waitForVerdict(second.patch_id, { pollMs: 5 });
    expect(v2.decision).toBe("REVIEW");
    expect(v2.score_history).toEqual([45, 85]);
  });

  it("malicious diff is blocked; diff with no test is unproven", async () => {
    const c = await setup();
    const bad = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("malicious.diff") });
    expect((await c.waitForVerdict(bad.patch_id, { pollMs: 5 })).decision).toBe("BLOCK");
    const nt = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("no_test.diff") });
    const v = await c.waitForVerdict(nt.patch_id, { pollMs: 5 });
    expect(v.decision).toBe("REVIEW");
    expect(v.unproven).toBe(true);
  });

  it("reconnects after a dropped SSE connection without losing or repeating events", async () => {
    const c = await setup({ dropSseAfter: 3 });
    const { patch_id } = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("good.diff") });
    const events = await collect(c.events(patch_id));
    expect(events).toEqual(server!.runs.get(patch_id)!.planned);
  });

  it("cancel ends the stream with a failed verdict event", async () => {
    const c = await setup({ eventDelayMs: 50 });
    const { patch_id } = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("good.diff") });
    const seen: PcpEvent[] = [];
    for await (const e of c.events(patch_id)) {
      seen.push(e);
      if (seen.length === 1) await c.cancel(patch_id);
    }
    expect(seen.at(-1)).toMatchObject({ stage: "verdict", status: "failed" });
  });

  it("an aborted signal stops the stream with CancelledError", async () => {
    const c = await setup({ eventDelayMs: 1000 });
    const { patch_id } = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("good.diff") });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(collect(c.events(patch_id, ac.signal))).rejects.toBeInstanceOf(CancelledError);
  });

  it("offline verifier gives one clear message", async () => {
    const c = await setup();
    const url = server!.url;
    await server!.close();
    server = undefined;
    const offline = new VerifierClient({ baseUrl: url, timeoutMs: 2000 });
    await expect(offline.health()).rejects.toBeInstanceOf(VerifierOfflineError);
    await expect(offline.health()).rejects.toThrow(/not reachable.*scripts\/dev\.sh/);
    void c;
  });

  it("times out instead of hanging", async () => {
    server = await startMockServer({ healthDelayMs: 500 });
    const c = new VerifierClient({ baseUrl: server.url, timeoutMs: 50 });
    await expect(c.health()).rejects.toBeInstanceOf(VerifierTimeoutError);
  });

  it("fails loudly when the verifier breaks the contract", async () => {
    const c = await setup({ invalidVerdict: true });
    const { patch_id } = await c.verify({ task: TASK, repo_root: "/repo", diff: diff("good.diff") });
    await expect(c.waitForVerdict(patch_id, { pollMs: 5 })).rejects.toBeInstanceOf(ContractError);
  });

  it("refuses to send a malformed request", async () => {
    const c = await setup();
    await expect(c.verify({ task: "", repo_root: "/repo", diff: "x" })).rejects.toBeInstanceOf(ContractError);
  });

  it("/llm/complete reports failover when the primary is down", async () => {
    const c = await setup({ primaryDown: true, primaryFailMs: 20 });
    const r = await c.llmComplete({ messages: [{ role: "user", content: "hi" }], purpose: "agent_patch" });
    expect(r.failed_over).toBe(true);
    expect(r.model_used).toMatch(/^secondary:/);
    expect(r.failover_ms).toBeGreaterThanOrEqual(15);
    expect(r.text).toContain("```diff");
  });
});
