// The verified agent loop (AGENTS.md 7.1 step 4):
//   task + context -> agent diff -> POST /verify -> REPAIR: feed repair_instructions back (max 3)
//                                                -> REVIEW: hand the hunks to the review panel
//                                                -> BLOCK:  stop and show decision_reason
// The loop never writes to the user's files; only HunkReview.accept does.
import type { VerifierClient } from "../api/client";
import { CancelledError } from "../api/client";
import type { Decision, PcpEvent, Verdict, VerifyRequest } from "../contracts";
import { MAX_ATTEMPTS } from "../contracts";
import type { ParsedDiff } from "../core/diff";
import { DiffParseError, parseUnifiedDiff, serializeDiff } from "../core/diff";
import type { ProposeInput } from "./prompt";

export interface Proposal {
  diff: string;
  /** The model's raw reply, if any. */
  text?: string;
  modelUsed?: string;
  failedOver?: boolean;
  failoverMs?: number;
  errors?: string[];
}

export interface AgentBackend {
  readonly name: string;
  propose(input: ProposeInput, signal?: AbortSignal): Promise<Proposal>;
  dispose?(): Promise<void>;
}

export interface AttemptRecord {
  n: number;
  patchId?: string;
  decision?: Decision;
  score?: number;
  modelUsed?: string;
  failedOver?: boolean;
  failoverMs?: number;
  error?: string;
}

export type LoopStatus = "review" | "blocked" | "gave_up" | "cancelled" | "failed";

export interface LoopResult {
  status: LoopStatus;
  verdict?: Verdict;
  diff?: string;
  parsed?: ParsedDiff;
  patchId?: string;
  attempts: AttemptRecord[];
  message: string;
}

export interface LoopHooks {
  onLog?(line: string): void;
  onAttempt?(n: number, max: number): void;
  onProposal?(p: Proposal, parsed: ParsedDiff, n: number): void;
  onSubmitted?(patchId: string, n: number): void;
  onEvent?(e: PcpEvent): void;
  onVerdict?(v: Verdict, diff: string, parsed: ParsedDiff): void;
}

/** Parses strictly; if the @@ counts are wrong (common in model output) recounts and re-serializes. */
export function normalizeDiff(text: string): { diff: string; parsed: ParsedDiff } {
  try {
    return { diff: text, parsed: parseUnifiedDiff(text) };
  } catch (e) {
    if (!(e instanceof DiffParseError)) throw e;
    const parsed = parseUnifiedDiff(text, { recount: true });
    return { diff: serializeDiff(parsed), parsed };
  }
}

/** One verification: submit, stream progress, return the verdict. Abort cancels the sandbox. */
export async function verifyOnce(
  client: VerifierClient,
  req: VerifyRequest,
  opts: { signal?: AbortSignal; onEvent?: (e: PcpEvent) => void; onSubmitted?: (id: string) => void; onLog?: (s: string) => void; timeoutMs?: number } = {},
): Promise<{ patchId: string; verdict: Verdict }> {
  const { signal } = opts;
  if (signal?.aborted) throw new CancelledError();
  const { patch_id } = await client.verify(req, signal);
  opts.onSubmitted?.(patch_id);
  const cancelRemote = () => {
    void client.cancel(patch_id).catch((e: unknown) => opts.onLog?.(`cancel failed: ${(e as Error).message}`));
  };
  signal?.addEventListener("abort", cancelRemote, { once: true });
  try {
    try {
      for await (const e of client.events(patch_id, signal)) opts.onEvent?.(e);
    } catch (e) {
      if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
      opts.onLog?.(`live progress unavailable (${(e as Error).message}); polling for the verdict`);
    }
    const verdict = await client.waitForVerdict(patch_id, { signal, timeoutMs: opts.timeoutMs });
    return { patchId: patch_id, verdict };
  } finally {
    signal?.removeEventListener("abort", cancelRemote);
  }
}

export interface LoopOptions {
  backend: AgentBackend;
  client: VerifierClient;
  task: string;
  repoRoot: string;
  context: string;
  maxAttempts?: number;
  approveBigRewrite?: boolean;
  signal?: AbortSignal;
  hooks?: LoopHooks;
  verdictTimeoutMs?: number;
}

const NO_DIFF_INSTRUCTIONS =
  "Your reply contained no unified diff. Reply with ONE ```diff fenced block containing a git-style unified diff against the original files.";

export async function runRepairLoop(o: LoopOptions): Promise<LoopResult> {
  const max = Math.max(1, Math.min(o.maxAttempts ?? MAX_ATTEMPTS, MAX_ATTEMPTS));
  const h = o.hooks ?? {};
  const attempts: AttemptRecord[] = [];
  let previous: { patchId: string; attempt: number; verdict: Verdict; diff: string; parsed: ParsedDiff } | undefined;
  let repair: string | undefined;
  let lastDiff: string | undefined;

  const cancelled = (): LoopResult => ({
    status: "cancelled",
    attempts,
    verdict: previous?.verdict,
    message: "Cancelled. The sandbox was stopped and no files were changed.",
  });

  try {
    for (let n = 1; n <= max; n++) {
      if (o.signal?.aborted) return cancelled();
      h.onAttempt?.(n, max);
      h.onLog?.(`Attempt ${n} of ${max}: asking ${o.backend.name} for a patch`);

      let proposal: Proposal;
      try {
        proposal = await o.backend.propose(
          {
            task: o.task,
            context: o.context,
            repoRoot: o.repoRoot,
            attempt: n,
            maxAttempts: max,
            repairInstructions: repair,
            previousDiff: lastDiff,
          },
          o.signal,
        );
      } catch (e) {
        if (o.signal?.aborted || e instanceof CancelledError) return cancelled();
        attempts.push({ n, error: (e as Error).message });
        return { status: "failed", attempts, message: `The agent (${o.backend.name}) failed: ${(e as Error).message}` };
      }
      if (proposal.failedOver) {
        h.onLog?.(`Primary model failed; ${proposal.modelUsed ?? "the backup"} answered after ${proposal.failoverMs ?? 0} ms`);
      }

      let norm: { diff: string; parsed: ParsedDiff };
      try {
        norm = normalizeDiff(proposal.diff);
      } catch (e) {
        norm = { diff: "", parsed: { files: [], hunks: [] } };
        h.onLog?.(`The agent's diff could not be parsed: ${(e as Error).message}`);
      }
      const record: AttemptRecord = {
        n,
        modelUsed: proposal.modelUsed,
        failedOver: proposal.failedOver,
        failoverMs: proposal.failoverMs,
      };
      attempts.push(record);
      if (norm.parsed.hunks.length === 0) {
        record.error = "no diff in the agent's reply";
        h.onLog?.(`Attempt ${n}: the agent's reply had no diff`);
        repair = NO_DIFF_INSTRUCTIONS;
        continue;
      }
      lastDiff = norm.diff;
      h.onProposal?.(proposal, norm.parsed, n);

      const verifyAttempt = previous ? previous.attempt + 1 : 1;
      h.onLog?.(`Attempt ${n}: verifying ${norm.parsed.hunks.length} hunk(s) in ${norm.parsed.files.length} file(s)`);
      const { patchId, verdict } = await verifyOnce(
        o.client,
        {
          task: o.task,
          repo_root: o.repoRoot,
          diff: norm.diff,
          attempt: verifyAttempt,
          previous_patch_id: previous?.patchId ?? null,
          approve_big_rewrite: !!o.approveBigRewrite,
        },
        {
          signal: o.signal,
          onEvent: h.onEvent,
          onSubmitted: (id) => h.onSubmitted?.(id, n),
          onLog: h.onLog,
          timeoutMs: o.verdictTimeoutMs,
        },
      );
      record.patchId = patchId;
      record.decision = verdict.decision;
      record.score = verdict.score;
      h.onVerdict?.(verdict, norm.diff, norm.parsed);
      const done = { verdict, diff: norm.diff, parsed: norm.parsed, patchId, attempts };

      if (o.signal?.aborted) return { ...cancelled(), ...done, status: "cancelled" };
      if (verdict.decision === "REVIEW") {
        return { status: "review", ...done, message: `REVIEW, score ${verdict.score}: accept or reject each hunk.` };
      }
      if (verdict.decision === "BLOCK") {
        return { status: "blocked", ...done, message: `BLOCKED: ${verdict.decision_reason}` };
      }
      previous = { patchId, attempt: verdict.attempt, verdict, diff: norm.diff, parsed: norm.parsed };
      repair = verdict.repair_instructions ?? verdict.summary_md;
      h.onLog?.(`Attempt ${n}: REPAIR (score ${verdict.score}); sending the verifier's instructions back to the agent`);
    }
  } catch (e) {
    if (o.signal?.aborted || e instanceof CancelledError) return cancelled();
    throw e;
  }

  return {
    status: "gave_up",
    attempts,
    verdict: previous?.verdict,
    diff: previous?.diff,
    parsed: previous?.parsed,
    patchId: previous?.patchId,
    message: `Still not good enough after ${max} attempts. A human decides.`,
  };
}
