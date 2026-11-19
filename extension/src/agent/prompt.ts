// Prompt text and diff extraction shared by every agent backend.

export interface ProposeInput {
  task: string;
  /** Rendered context bundle (files + why each was retrieved). */
  context: string;
  repoRoot: string;
  /** 1-based proposal number in this loop. */
  attempt: number;
  maxAttempts: number;
  /** The verifier's repair_instructions from the previous attempt. */
  repairInstructions?: string;
  previousDiff?: string;
}

export const SYSTEM_PROMPT = [
  "You are a careful coding agent. PCP, a verifier, will run the repository's tests on the old and new code",
  "in a sandbox and score your patch; it trusts the tests, not your words.",
  "Reply with ONE unified diff in git format (paths a/... and b/... relative to the repository root) against",
  "the ORIGINAL files, inside a single ```diff fenced block. Keep the change minimal.",
  "Add or extend a pytest test that fails before your change and passes after it.",
  "Never delete, skip, xfail or weaken an existing test. Do not touch unrelated files, lockfiles, CI config,",
  ".env or .git. Never hard-code secrets.",
].join(" ");

export function buildUserPrompt(i: ProposeInput): string {
  const parts = [`Task: ${i.task}`, "", "Repository context retrieved by PCP (with the reason for each file):", i.context];
  if (i.repairInstructions) {
    parts.push(
      "",
      `Your previous attempt (${i.attempt - 1} of ${i.maxAttempts}) was sent back by the PCP verifier:`,
      i.repairInstructions,
    );
    if (i.previousDiff) parts.push("", "Your previous diff:", "```diff", i.previousDiff.trimEnd(), "```");
    parts.push(
      "",
      `This is attempt ${i.attempt} of ${i.maxAttempts}. Return a COMPLETE corrected diff against the ORIGINAL files (not an incremental one).`,
    );
  }
  return parts.join("\n");
}

/** Pulls the unified diff out of a model reply (fenced block preferred, else raw diff text). */
export function extractDiff(text: string): string {
  const blocks = [...text.matchAll(/```[a-zA-Z]*[^\n]*\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .filter((b) => /^(diff --git |--- |@@ )/m.test(b));
  let diff = blocks.length > 0 ? blocks.join("\n") : "";
  if (!diff) {
    const at = text.search(/^(diff --git |--- a\/|--- \/dev\/null)/m);
    diff = at === -1 ? "" : text.slice(at);
  }
  if (diff && !diff.endsWith("\n")) diff += "\n";
  return diff;
}
