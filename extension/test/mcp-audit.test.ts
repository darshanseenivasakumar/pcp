import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AuditEntry } from "../src/mcp/audit";
import { AuditLog, maskSecrets, summarizeArgs } from "../src/mcp/audit";

const base = { tool: "run_command", tier: 2 as const, approvedBy: "user", outcome: "ok" as const, durationMs: 3, source: "agent" as const };

describe("maskSecrets", () => {
  it.each([
    ["token ghp_abcdefghijklmnop1234 here", "ghp_****"],
    ["key sk-proj-abcdefghijklmnop", "sk-****"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIA****"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y", "Bearer ****"],
    ['password="hunter22"', 'password="****"'],
  ])("%s", (input, masked) => {
    const out = maskSecrets(input);
    expect(out).toContain(masked);
    expect(out).not.toMatch(/abcdefghijklmnop|IOSFODNN7|eyJhbGci|hunter22/);
  });

  it("leaves ordinary text alone", () => {
    expect(maskSecrets("pytest -q tests/test_mathx.py")).toBe("pytest -q tests/test_mathx.py");
  });
});

describe("summarizeArgs", () => {
  it("is short, single-line and masked", () => {
    const s = summarizeArgs({ diff: "diff --git a/x b/x\n".repeat(50), argv: ["echo", "ghp_abcdefghijklmnop1234"] });
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s).not.toContain("\n");
    expect(s).toContain("ghp_****");
    expect(s).not.toContain("abcdefghijklmnop");
  });
});

describe("AuditLog", () => {
  it("assigns id and ISO time, masks args and notifies listeners", () => {
    const log = new AuditLog();
    const seen: AuditEntry[] = [];
    const off = log.onChange((e) => seen.push(e));
    const e = log.append({ ...base, args: "argv=echo sk-abcdefghijklmnopqrstu" + "x".repeat(300) });
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
    expect(new Date(e.time).toISOString()).toBe(e.time);
    expect(e.args.length).toBeLessThanOrEqual(160);
    expect(e.args).toContain("sk-****");
    expect(seen).toEqual([e]);
    off();
    log.append({ ...base, args: "" });
    expect(seen).toHaveLength(1);
    expect(log.entries()).toHaveLength(2);
  });

  it("keeps the last `max` entries and appends JSONL", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcp-audit-"));
    try {
      const path = join(dir, "sub", "audit.jsonl");
      const log = new AuditLog({ jsonlPath: path, max: 2 });
      for (const t of ["a", "b", "c"]) log.append({ ...base, tool: t, args: "" });
      expect(log.entries().map((e) => e.tool)).toEqual(["b", "c"]);
      const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
      expect(lines.map((e) => e.tool)).toEqual(["a", "b", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
