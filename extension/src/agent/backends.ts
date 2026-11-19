// Agent backends that do not need TrueForge: the verifier's model gateway (with failover,
// Task C) and a scripted backend that replays .diff files (demo + tests).
import type { VerifierClient } from "../api/client";
import type { AgentBackend, Proposal } from "./loop";
import type { ProposeInput } from "./prompt";
import { buildUserPrompt, extractDiff, SYSTEM_PROMPT } from "./prompt";

/** Asks the model through POST /llm/complete, so a broken primary fails over automatically. */
export class GatewayBackend implements AgentBackend {
  readonly name = "model gateway";
  constructor(private readonly client: VerifierClient) {}

  async propose(input: ProposeInput, signal?: AbortSignal): Promise<Proposal> {
    const res = await this.client.llmComplete(
      {
        purpose: input.attempt > 1 ? "agent_repair" : "agent_patch",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
        max_tokens: 4000,
      },
      signal,
    );
    return {
      diff: extractDiff(res.text),
      text: res.text,
      modelUsed: res.model_used,
      failedOver: !!res.failed_over,
      failoverMs: res.failover_ms,
      errors: res.errors,
    };
  }
}

/** Replays one diff per attempt (the last one repeats). Deterministic demos and tests. */
export class ScriptedBackend implements AgentBackend {
  readonly name: string;
  constructor(
    private readonly diffs: string[],
    label = "scripted diffs",
  ) {
    if (diffs.length === 0) throw new Error("ScriptedBackend needs at least one diff");
    this.name = label;
  }

  async propose(input: ProposeInput, signal?: AbortSignal): Promise<Proposal> {
    if (signal?.aborted) throw new Error("aborted");
    const diff = this.diffs[Math.min(input.attempt, this.diffs.length) - 1]!;
    return { diff, text: diff, modelUsed: this.name };
  }
}
