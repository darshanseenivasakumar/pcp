// Runtime validation of every message that crosses the verifier boundary (AGENTS.md rule 5).
// Types come from contracts/types.ts; shapes are checked against the JSON Schemas that
// contracts/gen_schemas.py generates from the Pydantic models, and Verdict invariants are
// re-checked here so the UI can never show green for a verdict the backend got wrong.
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";

import type {
  Health,
  LLMRequest,
  LLMResponse,
  PcpEvent,
  Verdict,
  VerifyRequest,
  VerifyResponse,
} from "../../contracts/types";
import { REVIEW_THRESHOLD } from "../../contracts/types";

import eventSchema from "../../contracts/schemas/event.schema.json";
import healthSchema from "../../contracts/schemas/health.schema.json";
import llmRequestSchema from "../../contracts/schemas/llm_request.schema.json";
import llmResponseSchema from "../../contracts/schemas/llm_response.schema.json";
import verdictSchema from "../../contracts/schemas/verdict.schema.json";
import verifyRequestSchema from "../../contracts/schemas/verify_request.schema.json";
import verifyResponseSchema from "../../contracts/schemas/verify_response.schema.json";

export * from "../../contracts/types";

export interface ContractMap {
  event: PcpEvent;
  health: Health;
  llm_request: LLMRequest;
  llm_response: LLMResponse;
  verdict: Verdict;
  verify_request: VerifyRequest;
  verify_response: VerifyResponse;
}
export type ContractName = keyof ContractMap;

export class ContractError extends Error {
  constructor(
    readonly contract: string,
    readonly problems: string[],
  ) {
    super(`${contract} does not match contracts/: ${problems.join("; ")}`);
    this.name = "ContractError";
  }
}

// strict:false because the generated schemas carry an `x-contracts-version` annotation.
const ajv = new Ajv2020({ allErrors: true, strict: false });

const schemas: Record<ContractName, object> = {
  event: eventSchema,
  health: healthSchema,
  llm_request: llmRequestSchema,
  llm_response: llmResponseSchema,
  verdict: verdictSchema,
  verify_request: verifyRequestSchema,
  verify_response: verifyResponseSchema,
};

const compiled = new Map<ContractName, ValidateFunction>();

function validator(name: ContractName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    v = ajv.compile(schemas[name]);
    compiled.set(name, v);
  }
  return v;
}

/** Returns the value typed as the contract, or throws ContractError listing every problem. */
export function parseContract<K extends ContractName>(name: K, value: unknown): ContractMap[K] {
  const v = validator(name);
  if (!v(value)) {
    const problems = (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
    throw new ContractError(name, problems);
  }
  if (name === "verdict") {
    const broken = verdictInvariantErrors(value as Verdict);
    if (broken.length) throw new ContractError("verdict", broken);
  }
  return value as ContractMap[K];
}

/** Mirror of Verdict._invariants in contracts/pcp_contracts.py. */
export function verdictInvariantErrors(v: Verdict): string[] {
  const errors: string[] = [];
  const anyCritical = v.checks.some((c) => c.status === "critical");
  if (anyCritical && v.decision !== "BLOCK") errors.push("a critical check forces BLOCK");
  if (v.score < REVIEW_THRESHOLD && v.decision === "REVIEW") errors.push("score < 70 can never be REVIEW");
  const bigRewrite = v.checks.some((c) =>
    (c.findings ?? []).some((f) => f.type === "big_rewrite" && f.validated !== "dismissed"),
  );
  if (bigRewrite && !v.big_rewrite_approved && v.decision !== "BLOCK") {
    errors.push("an unapproved big_rewrite goes to a human (BLOCK)");
  }
  if (v.decision === "REPAIR" && !(v.repair_instructions ?? "").trim()) {
    errors.push("REPAIR needs repair_instructions");
  }
  const proven = !!v.proof && v.proof.f2p_ok && v.proof.p2p_ok;
  if (v.decision === "REVIEW" && !proven && !v.unproven) {
    errors.push("REVIEW without a passing proof must be unproven");
  }
  if (v.score_history[v.score_history.length - 1] !== v.score) {
    errors.push("score_history must end with score");
  }
  return errors;
}

/** Score badge colour rule from AGENTS.md section 3 / 7.1(6). */
export type Badge = "green" | "yellow" | "red";
export function badgeFor(v: Pick<Verdict, "decision" | "unproven" | "score">): Badge {
  if (v.decision === "BLOCK") return "red";
  if (v.decision === "REVIEW" && !v.unproven && v.score >= REVIEW_THRESHOLD) return "green";
  return "yellow";
}
