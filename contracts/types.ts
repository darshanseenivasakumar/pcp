// PCP shared message contracts: TypeScript mirror of contracts/pcp_contracts.py.
// Hand-written. Keep in sync in the same contracts-only PR that changes the Python models.
// Contracts version: 0.1.0

export type CheckerName = "proof" | "safety" | "coverage" | "scope";
export type CheckStatus = "pass" | "warning" | "critical";
export type FindingType =
  | "test_failure"
  | "missing_test"
  | "tampering"
  | "secret"
  | "dangerous_call"
  | "removed_guard"
  | "out_of_scope"
  | "big_rewrite"
  | "other";
export type FindingSource = "heuristic" | "tool" | "test_output" | "llm";
export type Validated = "confirmed" | "dismissed" | "not_required";
export type Decision = "REVIEW" | "REPAIR" | "BLOCK";
export type Stage = "proof" | "checks" | "validate" | "verdict";
export type EventStatus = "started" | "done" | "failed";
export type TestOutcome = "passed" | "failed" | "skipped" | "error";
export type TamperKind = "deleted" | "skipped" | "weakened_assert" | "renamed";
export type HunkResult = "pass" | "fail" | "untested";

export const REVIEW_THRESHOLD = 70;
export const REPAIR_THRESHOLD = 40;
export const MAX_ATTEMPTS = 3;

export interface Hunk {
  hunk_id: string;
  file: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
}

export interface RunResult {
  exit_code: number;
  passed: number;
  failed: number;
  skipped?: number;
  errors?: number;
  duration_s: number;
  /** node id -> outcome, parsed by the host from junit XML */
  tests?: Record<string, TestOutcome>;
  output_tail?: string;
}

export interface FrozenManifest {
  f2p: string[];
  p2p: string[];
}

export interface TamperEvent {
  test_id: string;
  kind: TamperKind;
  detail: string;
}

export interface Proof {
  attempt: number;
  sandbox: string;
  frozen_manifest: FrozenManifest;
  baseline?: RunResult | null;
  patched?: RunResult | null;
  f2p_ok: boolean;
  p2p_ok: boolean;
  tampering?: TamperEvent[];
  apply_ok?: boolean;
  error?: string | null;
}

export interface Finding {
  id: string;
  type: FindingType;
  source: FindingSource;
  confidence: number; // 0..1
  file?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  evidence?: string;
  message: string;
  validated?: Validated;
}

export interface CheckResult {
  checker: CheckerName;
  risk_modifier: number; // 0..100
  status: CheckStatus;
  findings?: Finding[];
  recommended_action?: string;
}

export interface PatchContext {
  patch_id: string;
  attempt: number;
  task: string;
  repo_root: string;
  shadow_root: string;
  diff: string;
  changed_files: string[];
  hunks: Hunk[];
  proof?: Proof | null;
  approve_big_rewrite?: boolean;
}

export interface HunkEvidence {
  tests?: string[];
  result?: HunkResult;
  findings?: string[]; // Finding ids
}

export interface Verdict {
  patch_id: string;
  score: number; // 0..100
  decision: Decision;
  decision_reason: string;
  /** true => REVIEW without a passing proof run: show yellow, never green */
  unproven: boolean;
  attempt: number;
  score_history: number[];
  checks: CheckResult[];
  proof?: Proof | null;
  hunk_evidence?: Record<string, HunkEvidence>;
  repair_instructions?: string | null;
  summary_md: string;
  big_rewrite_approved?: boolean;
  created_at: string; // ISO-8601
}

export interface PcpEvent {
  patch_id: string;
  stage: Stage;
  status: EventStatus;
  message: string;
  data?: Record<string, unknown>;
}

export interface VerifyRequest {
  task: string;
  repo_root: string;
  diff: string;
  attempt?: number;
  previous_patch_id?: string | null;
  /** set after a human approves a >50% file rewrite */
  approve_big_rewrite?: boolean;
}

export interface VerifyResponse {
  patch_id: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  purpose: string;
  max_tokens?: number | null;
}

export interface LLMResponse {
  text: string;
  model_used: string;
  failover_ms: number;
  failed_over?: boolean;
  errors?: string[];
}

export interface Health {
  status: "ok";
  version: string;
  sandbox: string;
}
