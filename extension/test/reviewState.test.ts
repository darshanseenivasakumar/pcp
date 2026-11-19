import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PcpEvent, Verdict } from "../src/contracts";
import { parseUnifiedDiff } from "../src/core/diff";
import { applyEvent, applyVerdict, badgeText, initialState, outcomeOf, startAttempt } from "../src/ui/reviewState";

const EX = join(__dirname, "..", "..", "contracts", "examples");
const load = <T>(f: string) => JSON.parse(readFileSync(join(EX, f), "utf8")) as T;
const req = load<{ diff: string }>("verify_request.json");

describe("review view state", () => {
  it("badges: proven green, unproven yellow, repair amber, block red", () => {
    expect(badgeText(load<Verdict>("verdict_review.json"))).toEqual({ badge: "green", text: "PROVEN" });
    expect(badgeText(load<Verdict>("verdict_review_unproven.json")).badge).toBe("yellow");
    expect(badgeText(load<Verdict>("verdict_repair.json")).badge).toBe("amber");
    expect(badgeText(load<Verdict>("verdict_block.json")).badge).toBe("red");
  });

  it("streams stages, then maps hunk evidence and findings onto each hunk", () => {
    const s = initialState({ title: "t", mode: "inline", task: "x", backend: "b", maxAttempts: 3 });
    startAttempt(s, 1);
    for (const e of load<PcpEvent[]>("events_stream.json").slice(0, 4)) applyEvent(s, e);
    expect(s.stages[0]).toMatchObject({ stage: "proof", status: "done" });
    expect(s.stages[1]!.status).toBe("pending");

    applyVerdict(s, load<Verdict>("verdict_review.json"), parseUnifiedDiff(req.diff, { recount: true }));
    expect(s.canAccept).toBe(true);
    expect(s.verdict?.history).toEqual([45, 85]);
    expect(s.hunks.map((h) => [h.id, h.result, h.findings.map((f) => `${f.checker}:${f.id}`)])).toEqual([
      ["h1", "pass", ["coverage:f3"]],
      ["h2", "pass", ["scope:f4"]],
    ]);
    expect(s.hunks[0]!.tests[0]).toMatchObject({ outcome: "passed", baseline: "failed" });
  });

  it("never allows Accept on a BLOCK or REPAIR verdict", () => {
    const s = initialState({ title: "t", mode: "diff", task: "x", backend: "b", maxAttempts: 3 });
    applyVerdict(s, load<Verdict>("verdict_block.json"), parseUnifiedDiff(req.diff, { recount: true }));
    expect(s.canAccept).toBe(false);
    applyVerdict(s, load<Verdict>("verdict_repair.json"), parseUnifiedDiff(req.diff, { recount: true }));
    expect(s.canAccept).toBe(false);
  });
});

describe("outcomeOf", () => {
  it("folds parametrized cases into the base test id; any failure wins", () => {
    const tests = { "t.py::test_x[a]": "passed", "t.py::test_x[b]": "failed", "t.py::test_y": "passed" } as const;
    expect(outcomeOf(tests, "t.py::test_x")).toEqual({ outcome: "failed", cases: 2 });
    expect(outcomeOf(tests, "t.py::test_y")).toEqual({ outcome: "passed", cases: 1 });
    expect(outcomeOf(tests, "t.py::test_z")).toEqual({ cases: 0 });
  });
});
