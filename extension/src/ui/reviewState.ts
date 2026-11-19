// View model for the review panel. Pure (no vscode import) so it is unit-tested; the panel
// just renders whatever this produces.
import type {
  CheckerName,
  Finding,
  HunkEvidence,
  PcpEvent,
  Stage,
  TestOutcome,
  Verdict,
} from "../contracts";
import { badgeFor } from "../contracts";
import type { DiffLine, ParsedDiff } from "../core/diff";
import type { HunkState } from "../core/hunks";

export type StageStatus = "pending" | "started" | "done" | "failed";
export interface StageView {
  stage: Stage;
  label: string;
  status: StageStatus;
  message: string;
}

export interface FindingView extends Finding {
  checker: CheckerName;
}

export interface TestView {
  id: string;
  outcome?: TestOutcome; // on the patched code
  baseline?: TestOutcome;
}

export interface HunkView {
  id: string;
  file: string;
  header: string;
  lines: DiffLine[];
  state: HunkState;
  result: HunkEvidence["result"];
  tests: TestView[];
  findings: FindingView[];
  error?: string;
}

export interface VerdictView {
  patchId: string;
  score: number;
  decision: Verdict["decision"];
  badge: "green" | "yellow" | "amber" | "red";
  badgeText: string;
  unproven: boolean;
  reason: string;
  history: number[];
  summaryMd: string;
  repairInstructions?: string | null;
  checks: { checker: CheckerName; status: string; risk: number; action: string; findings: number }[];
  proof?: {
    f2pOk: boolean;
    p2pOk: boolean;
    baseline?: string;
    patched?: string;
    f2p: string[];
    tampering: string[];
    sandbox: string;
    error?: string | null;
  };
}

export interface ModelView {
  used?: string;
  failedOver?: boolean;
  failoverMs?: number;
}

export interface ReviewViewState {
  title: string;
  mode: "inline" | "agent" | "diff";
  task: string;
  backend: string;
  running: boolean;
  attempt: number;
  maxAttempts: number;
  stages: StageView[];
  log: { time: string; text: string; kind: "event" | "agent" | "error" }[];
  verdict?: VerdictView;
  hunks: HunkView[];
  canAccept: boolean;
  outcome?: { status: string; message: string };
  model?: ModelView;
}

const STAGES: [Stage, string][] = [
  ["proof", "Proof (tests old vs new)"],
  ["checks", "Checkers"],
  ["validate", "Validator"],
  ["verdict", "Verdict"],
];

export function initialState(p: { title: string; mode: ReviewViewState["mode"]; task: string; backend: string; maxAttempts: number }): ReviewViewState {
  return {
    ...p,
    running: true,
    attempt: 0,
    stages: freshStages(),
    log: [],
    hunks: [],
    canAccept: false,
  };
}

function freshStages(): StageView[] {
  return STAGES.map(([stage, label]) => ({ stage, label, status: "pending", message: "" }));
}

const now = () => new Date().toLocaleTimeString();

export function addLog(s: ReviewViewState, text: string, kind: "event" | "agent" | "error" = "agent"): void {
  s.log.push({ time: now(), text, kind });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

export function startAttempt(s: ReviewViewState, n: number): void {
  s.attempt = n;
  s.stages = freshStages();
  s.canAccept = false;
}

export function applyEvent(s: ReviewViewState, e: PcpEvent): void {
  const st = s.stages.find((x) => x.stage === e.stage);
  if (st) {
    // a later "started" message inside a done stage (e.g. per-checker) keeps it done
    if (!(st.status === "done" && e.status === "started")) st.status = e.status;
    st.message = e.message;
  }
  // stages before this one are finished once a later stage reports in
  const idx = s.stages.findIndex((x) => x.stage === e.stage);
  for (let i = 0; i < idx; i++) if (s.stages[i]!.status === "started" || s.stages[i]!.status === "pending") s.stages[i]!.status = "done";
  addLog(s, `[${e.stage}] ${e.message}`, e.status === "failed" ? "error" : "event");
}

export function badgeText(v: Pick<Verdict, "decision" | "unproven" | "score">): { badge: VerdictView["badge"]; text: string } {
  if (v.decision === "BLOCK") return { badge: "red", text: "BLOCKED" };
  if (v.decision === "REPAIR") return { badge: "amber", text: "REPAIR" };
  const b = badgeFor(v);
  return b === "green" ? { badge: "green", text: "PROVEN" } : { badge: "yellow", text: "UNPROVEN" };
}

function runSummary(r: { passed: number; failed: number; skipped?: number; errors?: number } | null | undefined): string | undefined {
  if (!r) return undefined;
  const extra = [r.skipped ? `${r.skipped} skipped` : "", r.errors ? `${r.errors} errors` : ""].filter(Boolean).join(", ");
  return `${r.passed} passed, ${r.failed} failed${extra ? `, ${extra}` : ""}`;
}

export function applyVerdict(s: ReviewViewState, v: Verdict, diff: ParsedDiff): void {
  for (const st of s.stages) if (st.status !== "failed") st.status = "done";
  const { badge, text } = badgeText(v);
  const allFindings = new Map<string, FindingView>();
  for (const c of v.checks) for (const f of c.findings ?? []) allFindings.set(f.id, { ...f, checker: c.checker });
  const p = v.proof;
  s.verdict = {
    patchId: v.patch_id,
    score: v.score,
    decision: v.decision,
    badge,
    badgeText: text,
    unproven: v.unproven,
    reason: v.decision_reason,
    history: v.score_history,
    summaryMd: v.summary_md,
    repairInstructions: v.repair_instructions,
    checks: v.checks.map((c) => ({
      checker: c.checker,
      status: c.status,
      risk: c.risk_modifier,
      action: c.recommended_action ?? "",
      findings: (c.findings ?? []).filter((f) => f.validated !== "dismissed").length,
    })),
    proof: p
      ? {
          f2pOk: p.f2p_ok,
          p2pOk: p.p2p_ok,
          baseline: runSummary(p.baseline),
          patched: runSummary(p.patched),
          f2p: p.frozen_manifest.f2p,
          tampering: (p.tampering ?? []).map((t) => `${t.kind}: ${t.test_id} (${t.detail})`),
          sandbox: p.sandbox,
          error: p.error,
        }
      : undefined,
  };
  const ev = v.hunk_evidence ?? {};
  s.hunks = diff.hunks.map((h) => {
    const e = ev[h.hunk_id];
    return {
      id: h.hunk_id,
      file: h.file,
      header: `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@ ${h.section}`.trimEnd(),
      lines: h.lines,
      state: "pending",
      result: e?.result ?? "untested",
      tests: (e?.tests ?? []).map((id) => ({ id, outcome: p?.patched?.tests?.[id], baseline: p?.baseline?.tests?.[id] })),
      findings: (e?.findings ?? []).map((id) => allFindings.get(id)).filter((f): f is FindingView => !!f),
    };
  });
  s.canAccept = v.decision === "REVIEW";
}

export function setHunkState(s: ReviewViewState, id: string, state: HunkState, error?: string): void {
  const h = s.hunks.find((x) => x.id === id);
  if (!h) return;
  h.state = state;
  h.error = error;
}
