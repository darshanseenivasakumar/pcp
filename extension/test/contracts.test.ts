import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ContractName, Verdict } from "../src/contracts";
import { badgeFor, ContractError, parseContract, verdictInvariantErrors } from "../src/contracts";

const EXAMPLES = join(__dirname, "..", "..", "contracts", "examples");
const load = (name: string): unknown => JSON.parse(readFileSync(join(EXAMPLES, name), "utf8"));

const CONTRACT_FOR: Record<string, ContractName> = {
  health: "health",
  llm_request: "llm_request",
  llm_response: "llm_response",
  llm_simulate_request: "llm_simulate_request",
  llm_status: "llm_status",
  verdict: "verdict",
  verify_request: "verify_request",
  verify_response: "verify_response",
};

describe("contracts/examples validate on the TypeScript side", () => {
  const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const key = Object.keys(CONTRACT_FOR)
      .filter((k) => file === `${k}.json` || file.startsWith(`${k}_`))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) continue; // shapes the extension never receives (proof, finding, ...) are P1's
    it(file, () => {
      expect(() => parseContract(CONTRACT_FOR[key]!, load(file))).not.toThrow();
    });
  }

  it("every event in events_stream.json is a valid Event", () => {
    for (const e of load("events_stream.json") as unknown[]) parseContract("event", e);
  });
});

describe("loud failures", () => {
  it("rejects unknown fields", () => {
    expect(() => parseContract("health", { status: "ok", version: "1", sandbox: "x", extra: 1 })).toThrow(ContractError);
  });

  it("rejects a REVIEW verdict with a critical check (invariant)", () => {
    const v = load("verdict_block.json") as Verdict;
    v.decision = "REVIEW";
    expect(verdictInvariantErrors(v)).toContain("a critical check forces BLOCK");
    expect(() => parseContract("verdict", v)).toThrow(/critical check forces BLOCK/);
  });

  it("rejects REVIEW without proof that is not marked unproven", () => {
    const v = load("verdict_review_unproven.json") as Verdict;
    v.unproven = false;
    expect(() => parseContract("verdict", v)).toThrow(/unproven/);
  });

  it("rejects score_history that does not end with score", () => {
    const v = load("verdict_review.json") as Verdict;
    v.score_history = [85, 45];
    expect(() => parseContract("verdict", v)).toThrow(/score_history/);
  });
});

describe("badgeFor", () => {
  it("green only for proven REVIEW", () => {
    expect(badgeFor(load("verdict_review.json") as Verdict)).toBe("green");
    expect(badgeFor(load("verdict_review_unproven.json") as Verdict)).toBe("yellow");
    expect(badgeFor(load("verdict_repair.json") as Verdict)).toBe("yellow");
    expect(badgeFor(load("verdict_block.json") as Verdict)).toBe("red");
  });
});
