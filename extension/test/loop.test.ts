import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MockOptions, MockServer } from "../dev/mock-server";
import { startMockServer } from "../dev/mock-server";
import { VerifierClient } from "../src/api/client";
import { GatewayBackend, ScriptedBackend } from "../src/agent/backends";
import type { AgentBackend } from "../src/agent/loop";
import { runRepairLoop } from "../src/agent/loop";
import type { ProposeInput } from "../src/agent/prompt";
import { extractDiff } from "../src/agent/prompt";
import type { TfEvent, TrueForgeLike } from "../src/agent/trueforge";
import { bareToolName, TrueForgeBackend } from "../src/agent/trueforge";

const TINY = join(__dirname, "..", "..", "fixtures", "tiny_repo");
const diff = (name: string) => readFileSync(join(TINY, "diffs", name), "utf8");
const TASK = 'Make parse_bool also treat "on" as true.';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(opts: MockOptions = {}) {
  server = await startMockServer({ eventDelayMs: 2, ...opts });
  return new VerifierClient({ baseUrl: server.url, timeoutMs: 3000, sseRetryDelayMs: 5 });
}

const loop = (client: VerifierClient, backend: AgentBackend, extra: Partial<Parameters<typeof runRepairLoop>[0]> = {}) =>
  runRepairLoop({ backend, client, task: TASK, repoRoot: TINY, context: "(context)", verdictTimeoutMs: 5000, ...extra });

describe("runRepairLoop", () => {
  it("fixable -> REPAIR -> fixed -> REVIEW, chaining attempt and previous_patch_id", async () => {
    const client = await setup();
    const r = await loop(client, new ScriptedBackend([diff("fixable.diff"), diff("fixable_v2.diff")]));
    expect(r.status).toBe("review");
    expect(r.attempts.map((a) => a.decision)).toEqual(["REPAIR", "REVIEW"]);
    expect(r.verdict?.score_history).toEqual([45, 85]);
    const second = server!.runs.get(r.attempts[1]!.patchId!)!;
    expect(second.request.attempt).toBe(2);
    expect(second.request.previous_patch_id).toBe(r.attempts[0]!.patchId);
  });

  it("stops at 3 attempts when the verdict stays REPAIR", async () => {
    const client = await setup({ scenario: "always-repair" });
    const backend = new ScriptedBackend([diff("fixable.diff")]);
    const spy = vi.spyOn(backend, "propose");
    const r = await loop(client, backend, { maxAttempts: 7 }); // clamped to MAX_ATTEMPTS = 3
    expect(r.status).toBe("gave_up");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(server!.runs.size).toBe(3);
    expect(r.attempts.map((a) => a.n)).toEqual([1, 2, 3]);
  });

  it("sends the verifier's repair_instructions back to the agent", async () => {
    const client = await setup();
    const inputs: ProposeInput[] = [];
    const backend: AgentBackend = {
      name: "spy",
      propose: async (i) => {
        inputs.push(i);
        return { diff: i.attempt === 1 ? diff("fixable.diff") : diff("fixable_v2.diff") };
      },
    };
    await loop(client, backend);
    expect(inputs[0]!.repairInstructions).toBeUndefined();
    expect(inputs[1]!.repairInstructions).toMatch(/Fix these and resubmit/);
    expect(inputs[1]!.previousDiff).toBe(diff("fixable.diff"));
  });

  it("a malicious patch is BLOCKED with the reason", async () => {
    const client = await setup();
    const r = await loop(client, new ScriptedBackend([diff("malicious.diff")]));
    expect(r.status).toBe("blocked");
    expect(r.message).toMatch(/AWS access key/);
  });

  it("a reply without a diff counts as an attempt and is re-prompted, without calling the verifier", async () => {
    const client = await setup({ scenario: "review" });
    const inputs: ProposeInput[] = [];
    const backend: AgentBackend = {
      name: "chatty",
      propose: async (i) => {
        inputs.push(i);
        return i.attempt === 1 ? { diff: "", text: "I think it is fine." } : { diff: diff("good.diff") };
      },
    };
    const r = await loop(client, backend);
    expect(inputs[1]!.repairInstructions).toMatch(/no unified diff/);
    expect(r.attempts[0]!.error).toMatch(/no diff/);
    expect(server!.runs.size).toBe(1);
    expect(server!.runs.values().next().value!.request.attempt).toBe(1);
  });

  it("cancel stops the sandbox and leaves git status clean", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pcp-cancel-"));
    try {
      cpSync(TINY, repo, { recursive: true });
      const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
      git("init", "-q");
      git("config", "core.autocrlf", "false");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      git("add", "-A");
      git("commit", "-q", "-m", "base");

      const client = await setup({ eventDelayMs: 150 });
      const ac = new AbortController();
      const r = await runRepairLoop({
        backend: new ScriptedBackend([diff("good.diff")]),
        client,
        task: TASK,
        repoRoot: repo,
        context: "",
        signal: ac.signal,
        hooks: { onEvent: () => ac.abort() },
      });
      expect(r.status).toBe("cancelled");
      expect(git("status", "--porcelain").trim()).toBe("");
      await vi.waitFor(() => expect([...server!.runs.values()][0]!.cancelled).toBe(true));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("gateway backend reports the failover when the primary model is broken", async () => {
    const client = await setup({ primaryDown: true, primaryFailMs: 5 });
    const lines: string[] = [];
    const r = await loop(client, new GatewayBackend(client), { hooks: { onLog: (l) => lines.push(l) } });
    expect(r.attempts[0]!.failedOver).toBe(true);
    expect(r.attempts[0]!.modelUsed).toBe("secondary:mock-backup");
    expect(lines.some((l) => /Primary model failed; secondary:mock-backup answered/.test(l))).toBe(true);
  });
});

describe("extractDiff", () => {
  it("takes the fenced diff block out of a model reply", () => {
    expect(extractDiff("Sure!\n```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```\nDone.")).toBe(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    );
  });
  it("falls back to raw diff text, and returns '' when there is none", () => {
    expect(extractDiff("diff --git a/x b/x\n--- a/x")).toBe("diff --git a/x b/x\n--- a/x\n");
    expect(extractDiff("no patch here")).toBe("");
  });
});

describe("TrueForgeBackend", () => {
  async function* events(list: TfEvent[]): AsyncIterable<TfEvent> {
    for (const e of list) yield e;
  }

  it("answers tool approvals through PCP and returns the agent's diff", async () => {
    const patch = diff("good.diff");
    const calls: unknown[] = [];
    const fake: TrueForgeLike = {
      sessions: {
        create: async () => ({ data: { id: "s1" } }),
        createTurnStream: async () =>
          events([
            { type: "turn.created", id: "e1", turnId: "t1" },
            {
              type: "model.message",
              id: "e2",
              toolCalls: [{ id: "c1", function: { name: "pcp-editor__run_tests", arguments: '{"diff":"x"}' } }],
            },
            { type: "tool.approval_required", id: "e3", threadId: "th", toolCalls: [{ id: "c1", sourceEventId: "e2" }] },
          ]),
        createTurnEvents: async (_s, _t, req) => {
          calls.push(req);
          return {};
        },
        subscribeToTurn: async (_s, _t, req) => {
          calls.push(req);
          return events([
            { type: "model.message.delta", id: "e4", content: "Here you go\n```diff\n" + patch + "```" },
            { type: "turn.done", id: "e5", state: { status: "done", output: null } },
          ]);
        },
      },
    };
    const approve = vi.fn(async () => true);
    const tf = new TrueForgeBackend({ baseUrl: "http://tf", model: "openai/x", mcpServerName: "pcp-editor", approve, client: fake });
    const p = await tf.propose({ task: TASK, context: "", repoRoot: TINY, attempt: 1, maxAttempts: 3 });
    expect(approve).toHaveBeenCalledWith({ tool: "run_tests", args: { diff: "x" } });
    expect(calls[0]).toEqual({
      events: [{ type: "user.tool_approval", threadId: "th", toolCallId: "c1", approval: { status: "allow" } }],
    });
    expect(calls[1]).toEqual({ afterEventId: "e3" });
    expect(p.diff).toBe(patch);
  });

  it("bareToolName strips the server prefix", () => {
    expect(bareToolName("pcp-editor__run_tests")).toBe("run_tests");
    expect(bareToolName("pcp-editor.write_file")).toBe("write_file");
    expect(bareToolName("read_file")).toBe("read_file");
  });
});
