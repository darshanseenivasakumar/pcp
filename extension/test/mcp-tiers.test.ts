import { describe, expect, it } from "vitest";

import { ApprovalGate, matchAllowList, stableJson } from "../src/mcp/tiers";
import { FakePrompter } from "./mcp-helpers";

const ALLOW = ["pytest", "git diff"];

describe("matchAllowList", () => {
  it.each([
    ["git diff", "git diff"],
    ["git diff --stat", "git diff"],
    ["pytest", "pytest"],
    ["pytest -q tests", "pytest"],
    ["  pytest   -q  ", "pytest"],
  ])("%s is auto-approved by %s", (cmd, entry) => {
    expect(matchAllowList(cmd, ALLOW)).toBe(entry);
  });

  it.each(["git difftool", "pytestx", "rm -rf x", "git", "py test", "git status", ""])("%s asks", (cmd) => {
    expect(matchAllowList(cmd, ALLOW)).toBeUndefined();
  });

  it("never matches shell metacharacters or writing flags", () => {
    expect(matchAllowList("pytest; rm -rf /", ALLOW)).toBeUndefined();
    expect(matchAllowList("pytest && curl x", ALLOW)).toBeUndefined();
    expect(matchAllowList("git diff --output=/tmp/x", ALLOW)).toBeUndefined();
    expect(matchAllowList("git diff --ext-diff", ALLOW)).toBeUndefined();
  });

  it("an empty allow-list matches nothing", () => {
    expect(matchAllowList("pytest", [])).toBeUndefined();
    expect(matchAllowList("pytest", ["", "  "])).toBeUndefined();
  });
});

describe("ApprovalGate", () => {
  const q2 = (command: string, args: unknown = { argv: command.split(" ") }) => ({
    tool: "run_command",
    tier: 2 as const,
    summary: `run: ${command}`,
    command,
    args,
  });

  it("tier 0 and tier 1 are automatic", async () => {
    const p = new FakePrompter(false);
    const gate = new ApprovalGate({ allowList: [], prompter: p });
    expect(await gate.decide({ tool: "read_file", tier: 0, summary: "read x", args: {} })).toEqual({
      allowed: true,
      approvedBy: "auto (tier 0)",
    });
    expect(await gate.decide({ tool: "apply_patch_to_shadow", tier: 1, summary: "s", args: {} })).toEqual({
      allowed: true,
      approvedBy: "auto (tier 1, shadow only)",
    });
    expect(p.asked).toHaveLength(0);
  });

  it("tier 2: allow-list, else ask the user", async () => {
    const p = new FakePrompter(false);
    const gate = new ApprovalGate({ allowList: ALLOW, prompter: p });
    expect(await gate.decide(q2("git diff"))).toMatchObject({ allowed: true, approvedBy: "allow-list: git diff" });
    expect(await gate.decide(q2("pytest -q"))).toMatchObject({ allowed: true, approvedBy: "allow-list: pytest" });
    expect(p.asked).toHaveLength(0);

    expect(await gate.decide(q2("git difftool"))).toMatchObject({ allowed: false, approvedBy: "denied by user" });
    expect(await gate.decide(q2("rm -rf x"))).toMatchObject({ allowed: false, approvedBy: "denied by user" });
    expect(p.asked.map((q) => q.command)).toEqual(["git difftool", "rm -rf x"]);

    p.answer = true;
    expect(await gate.decide(q2("rm -rf x"))).toEqual({ allowed: true, approvedBy: "user" });

    gate.setAllowList([]);
    p.answer = false;
    expect(await gate.decide(q2("pytest -q"))).toMatchObject({ allowed: false, approvedBy: "denied by user" });
    expect(p.asked.at(-1)?.command).toBe("pytest -q");
  });

  it("a prompter that throws denies", async () => {
    const gate = new ApprovalGate({
      allowList: [],
      prompter: { ask: () => Promise.reject(new Error("dialog closed")) },
    });
    expect(await gate.decide(q2("make"))).toMatchObject({ allowed: false, approvedBy: "policy: approval prompt failed" });
  });

  it("preApprove skips the prompt for the next identical call, once", async () => {
    const p = new FakePrompter(false);
    const gate = new ApprovalGate({ allowList: [], prompter: p });
    gate.preApprove("run_command", { argv: ["make", "test"], extra: { b: 1, a: 2 } });
    // Key order does not matter (stable JSON); different args do.
    expect(await gate.decide(q2("make lint", { argv: ["make", "lint"] }))).toMatchObject({ allowed: false });
    expect(await gate.decide(q2("make test", { extra: { a: 2, b: 1 }, argv: ["make", "test"] }))).toEqual({
      allowed: true,
      approvedBy: "trueforge approval",
    });
    expect(p.asked).toHaveLength(1);
    expect(await gate.decide(q2("make test", { argv: ["make", "test"], extra: { a: 2, b: 1 } }))).toMatchObject({
      allowed: false,
      approvedBy: "denied by user",
    });
    expect(p.asked).toHaveLength(2);
  });

  it("pre-approvals expire", async () => {
    const p = new FakePrompter(false);
    const gate = new ApprovalGate({ allowList: [], prompter: p, preApproveTtlMs: -1 });
    gate.preApprove("run_command", { argv: ["make"] });
    expect(await gate.decide(q2("make", { argv: ["make"] }))).toMatchObject({ allowed: false });
  });

  it("tier 3 needs an accepted hunk; prompts, allow-list and preApprove never unlock it", async () => {
    const p = new FakePrompter(true);
    const gate = new ApprovalGate({ allowList: ["write_file", "pytest"], prompter: p });
    gate.preApprove("write_file", { hunk_id: "h1" });
    const q3 = { tool: "write_file", tier: 3 as const, summary: "write h1", command: "write_file h1", args: { hunk_id: "h1" } };
    expect(await gate.decide(q3)).toMatchObject({ allowed: false, approvedBy: "policy: no accepted hunk" });
    expect(await gate.decide({ ...q3, acceptedHunk: null })).toMatchObject({ allowed: false });
    expect(p.asked).toHaveLength(0);
    expect(await gate.decide({ ...q3, acceptedHunk: "h1" })).toEqual({ allowed: true, approvedBy: "accepted hunk h1" });
  });

  it("stableJson sorts keys at every level", () => {
    expect(stableJson({ b: [{ y: 1, x: 2 }], a: 1 })).toBe('{"a":1,"b":[{"x":2,"y":1}]}');
  });
});
