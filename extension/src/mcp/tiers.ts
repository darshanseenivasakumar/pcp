// Tool tiers and the approval gate (rubric B4, AGENTS.md 7.1 step 3).
//
//   tier 0  read            auto
//   tier 1  shadow write    auto (in memory / sandbox only, never the user's disk)
//   tier 2  exec            allow-list prefix, else a TrueForge pre-approval, else ask the user
//   tier 3  write user file ONLY for a hunk the developer accepted in the review panel;
//                           no allow-list, prompt or pre-approval can unlock it (AGENTS.md rule 1)
//
// No `vscode` import here: the extension passes in a Prompter backed by a modal dialog.

export type Tier = 0 | 1 | 2 | 3; // 0 read, 1 shadow write (no disk), 2 exec, 3 write user files

export interface ApprovalQuestion {
  tool: string;
  tier: Tier;
  /** One line shown to the approver, e.g. "run: pytest -q tests". */
  summary: string;
  /** The command line matched against the allow-list (tier 2 only). */
  command?: string;
}

export interface Prompter {
  ask(q: ApprovalQuestion): Promise<boolean>;
}

export interface Decision {
  allowed: boolean;
  /**
   * Who or what allowed (or refused) the call: "auto (tier 0)", "auto (tier 1, shadow only)",
   * "allow-list: <prefix>", "trueforge approval", "user", "accepted hunk h2", "denied by user",
   * "policy: <why>".
   */
  approvedBy: string;
  reason?: string;
}

export const WRITE_DENIED_REASON = "write_file only applies hunks the developer accepted in the PCP review panel";

/** Characters that would change a command's meaning if it ever reached a shell. */
const SHELL_META = /[;&|`$<>\r\n]/;
/** Flags that turn an allow-listed read-only command into a writer or a code runner. */
const UNSAFE_FLAG = /(^|\s)--(output|ext-diff|exec-path)(=|\s|$)/;

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/**
 * Whole-word prefix match. "pytest" matches "pytest -q tests" but not "pytestx"; "git diff"
 * matches "git diff --stat" but not "git difftool". Returns the matching allow-list entry.
 * A command with shell metacharacters or a writing flag (`--output=...`) never matches.
 */
export function matchAllowList(command: string, allowList: string[]): string | undefined {
  if (SHELL_META.test(command) || UNSAFE_FLAG.test(command)) return undefined;
  const cmd = words(command);
  for (const entry of allowList) {
    const prefix = words(entry);
    if (prefix.length === 0 || prefix.length > cmd.length) continue;
    if (prefix.every((w, i) => cmd[i] === w)) return entry.trim();
  }
  return undefined;
}

/** JSON with object keys sorted at every level, so equal args give equal keys. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return v;
  }) ?? "undefined";
}

export class ApprovalGate {
  private allowList: string[];
  private readonly prompter: Prompter;
  private readonly ttlMs: number;
  /** tool + stable args -> expiry times of one-shot pre-approvals. */
  private readonly pre = new Map<string, number[]>();

  constructor(opts: { allowList: string[]; prompter: Prompter; preApproveTtlMs?: number }) {
    this.allowList = [...opts.allowList];
    this.prompter = opts.prompter;
    this.ttlMs = opts.preApproveTtlMs ?? 5 * 60_000;
  }

  setAllowList(list: string[]): void {
    this.allowList = [...list];
  }

  /**
   * TrueForge already asked the user about exactly this call: let the next identical tier-2 call
   * through without a second prompt. One-shot, and it expires. Never applies to tier 3.
   */
  preApprove(tool: string, args: unknown): void {
    const key = `${tool}\u0000${stableJson(args)}`;
    const list = this.pre.get(key) ?? [];
    list.push(Date.now() + this.ttlMs);
    this.pre.set(key, list);
  }

  async decide(q: ApprovalQuestion & { args: unknown; acceptedHunk?: string | null }): Promise<Decision> {
    switch (q.tier) {
      case 0:
        return { allowed: true, approvedBy: "auto (tier 0)" };
      case 1:
        return { allowed: true, approvedBy: "auto (tier 1, shadow only)" };
      case 2: {
        const hit = q.command === undefined ? undefined : matchAllowList(q.command, this.allowList);
        if (hit) return { allowed: true, approvedBy: `allow-list: ${hit}` };
        if (this.takePreApproval(q.tool, q.args)) return { allowed: true, approvedBy: "trueforge approval" };
        let ok: boolean;
        try {
          ok = await this.prompter.ask({ tool: q.tool, tier: q.tier, summary: q.summary, command: q.command });
        } catch (e) {
          return { allowed: false, approvedBy: "policy: approval prompt failed", reason: (e as Error).message };
        }
        return ok
          ? { allowed: true, approvedBy: "user" }
          : { allowed: false, approvedBy: "denied by user", reason: `the developer declined: ${q.summary}` };
      }
      case 3:
        if (q.acceptedHunk) return { allowed: true, approvedBy: `accepted hunk ${q.acceptedHunk}` };
        return { allowed: false, approvedBy: "policy: no accepted hunk", reason: WRITE_DENIED_REASON };
      default:
        return { allowed: false, approvedBy: "policy: unknown tier", reason: `unknown tier ${String(q.tier)}` };
    }
  }

  private takePreApproval(tool: string, args: unknown): boolean {
    const key = `${tool}\u0000${stableJson(args)}`;
    const now = Date.now();
    const live = (this.pre.get(key) ?? []).filter((t) => t > now);
    const ok = live.length > 0;
    if (ok) live.shift();
    if (live.length > 0) this.pre.set(key, live);
    else this.pre.delete(key);
    return ok;
  }
}
