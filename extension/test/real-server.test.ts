// Integration test against Person 1's real verifier. Skipped unless PCP_REAL_URL is set:
//   PCP_REAL_URL=http://127.0.0.1:8765 npx vitest run test/real-server.test.ts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { VerifierClient } from "../src/api/client";
import type { PcpEvent } from "../src/contracts";

const URL = process.env.PCP_REAL_URL;
const TINY = resolve(__dirname, "..", "..", "fixtures", "tiny_repo");
const diff = (name: string) => readFileSync(join(TINY, "diffs", name), "utf8");
const TASK = 'Make parse_bool also treat "on" as true.';

describe.skipIf(!URL)("real verifier", () => {
  const c = new VerifierClient({ baseUrl: URL ?? "", timeoutMs: 20_000 });

  async function run(d: string, attempt = 1, previous?: string) {
    const { patch_id } = await c.verify({ task: TASK, repo_root: TINY, diff: d, attempt, previous_patch_id: previous ?? null });
    const events: PcpEvent[] = [];
    for await (const e of c.events(patch_id)) events.push(e);
    return { patch_id, events, verdict: await c.waitForVerdict(patch_id, { pollMs: 200 }) };
  }

  it("good diff -> REVIEW, proven", async () => {
    const r = await run(diff("good.diff"));
    expect(r.events.at(-1)?.stage).toBe("verdict");
    expect(r.verdict.decision).toBe("REVIEW");
    expect(r.verdict.unproven).toBe(false);
  }, 120_000);

  it("fixable -> REPAIR, then fixed -> REVIEW with a rising score", async () => {
    const a = await run(diff("fixable.diff"));
    expect(a.verdict.decision).toBe("REPAIR");
    const b = await run(diff("fixable_v2.diff"), 2, a.patch_id);
    expect(b.verdict.decision).toBe("REVIEW");
    expect(b.verdict.score_history.length).toBe(2);
    expect(b.verdict.score_history[1]!).toBeGreaterThan(b.verdict.score_history[0]!);
  }, 180_000);

  it("malicious -> BLOCK", async () => {
    const r = await run(diff("malicious.diff"));
    expect(r.verdict.decision).toBe("BLOCK");
  }, 120_000);

  it("llm status / simulate / failover", async () => {
    await c.llmSimulate({ primary: "fail" });
    const r = await c.llmComplete({ messages: [{ role: "user", content: "ping" }], purpose: "probe" });
    expect(r.failed_over).toBe(true);
    expect((await c.llmStatus()).last_model_used).toBe(r.model_used);
    await c.llmSimulate({ primary: "ok" });
  }, 60_000);
});
