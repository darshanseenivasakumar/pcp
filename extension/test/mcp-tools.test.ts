import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WRITE_DENIED_REASON } from "../src/mcp/tiers";
import { globToRegExp, RUN_TESTS_COMMAND } from "../src/mcp/tools";
import { diffFixture, FakeWriteGate, setup, tempRepo } from "./mcp-helpers";

let repo: ReturnType<typeof tempRepo>;
beforeEach(() => {
  repo = tempRepo();
});
afterEach(() => repo.cleanup());

/** argv for a node one-liner that creates `file` when (and only when) it actually runs. */
const touchArgv = (file: string) => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "ran")`];

function snapshot(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(p, readFileSync(p));
    }
  };
  walk(root);
  return out;
}

describe("tier 2 needs approval", () => {
  it("run_command denied by the user does not run", async () => {
    const { runner, prompter, audit } = setup({ root: repo.root, answer: false });
    const marker = join(repo.root, "ran.txt");
    const out = await runner.call("run_command", { argv: touchArgv(marker) });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^Denied \(denied by user\)/);
    expect(prompter.asked).toHaveLength(1);
    expect(prompter.asked[0]).toMatchObject({ tool: "run_command", tier: 2 });
    expect(prompter.asked[0]!.command).toContain(process.execPath.includes(" ") ? JSON.stringify(process.execPath) : process.execPath);
    expect(existsSync(marker)).toBe(false);
    expect(audit.entries()).toHaveLength(1);
    expect(audit.entries()[0]).toMatchObject({ tool: "run_command", tier: 2, outcome: "denied", approvedBy: "denied by user" });
  });

  it("run_command approved by the user runs, no shell", async () => {
    const { runner, audit } = setup({ root: repo.root, answer: true });
    const marker = join(repo.root, "ran.txt");
    const out = await runner.call("run_command", { argv: touchArgv(marker) });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("exit 0");
    expect(readFileSync(marker, "utf8")).toBe("ran");
    expect(audit.entries()[0]).toMatchObject({ outcome: "ok", approvedBy: "user" });
  });

  it("a failing command reports its exit code", async () => {
    const { runner } = setup({ root: repo.root, answer: true });
    const out = await runner.call("run_command", { argv: [process.execPath, "-e", "process.exit(3)"] });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("exit 3");
  });

  it("allow-list: git diff and pytest run without asking; setAllowList([]) makes pytest ask", async () => {
    const { runner, prompter, gate, audit, verifier } = setup({ root: repo.root, answer: false });
    await runner.call("run_command", { argv: ["git", "diff", "--stat"] });
    expect(prompter.asked).toHaveLength(0);
    expect(audit.entries()[0]?.approvedBy).toBe("allow-list: git diff");

    const t = await runner.call("run_tests", { diff: diffFixture("good.diff") });
    expect(prompter.asked).toHaveLength(0);
    expect(audit.entries()[1]?.approvedBy).toBe("allow-list: pytest");
    expect(t.ok).toBe(true);

    await runner.call("run_command", { argv: ["git", "difftool"] });
    await runner.call("run_command", { argv: ["rm", "-rf", "x"] });
    expect(prompter.asked.map((q) => q.command)).toEqual(["git difftool", "rm -rf x"]);

    gate.setAllowList([]);
    const denied = await runner.call("run_tests", { diff: diffFixture("good.diff") });
    expect(denied.ok).toBe(false);
    expect(prompter.asked.at(-1)).toMatchObject({ tool: "run_tests", command: RUN_TESTS_COMMAND });
    expect(verifier.requests).toHaveLength(1); // the denied run never reached the verifier
  });

  it("preApprove lets the next identical call through without a prompt, once", async () => {
    const { runner, prompter, gate, audit } = setup({ root: repo.root, answer: false });
    const marker = join(repo.root, "ran.txt");
    const args = { argv: touchArgv(marker) };
    gate.preApprove("run_command", args);
    const first = await runner.call("run_command", args);
    expect(first.ok).toBe(true);
    expect(prompter.asked).toHaveLength(0);
    expect(audit.entries()[0]?.approvedBy).toBe("trueforge approval");
    const second = await runner.call("run_command", args);
    expect(second.ok).toBe(false);
    expect(prompter.asked).toHaveLength(1);
  });
});

describe("run_tests", () => {
  it("posts the diff to the verifier and summarizes the verdict", async () => {
    const { runner, verifier } = setup({ root: repo.root });
    const out = await runner.call("run_tests", { diff: diffFixture("good.diff") });
    expect(verifier.requests[0]).toMatchObject({ repo_root: repo.root, task: "Make parse_bool also treat on as true.", attempt: 1 });
    expect(out.text).toContain("Verdict: REPAIR (score 45");
    expect(out.text).toContain("test_debug_flag_off_values[OFF]");
    expect(out.text).toContain("Repair instructions:");
    expect(out.data).toMatchObject({ decision: "REPAIR", score: 45, f2p_ok: false, p2p_ok: true });
    expect((out.data as { failing: string[] }).failing).toHaveLength(2);
  });
});

describe("write_file (tier 3)", () => {
  it("is denied without an open review or an accepted hunk", async () => {
    const { runner, audit } = setup({ root: repo.root, answer: true });
    const out = await runner.call("write_file", { hunk_id: "h1" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain(WRITE_DENIED_REASON);
    expect(audit.entries()[0]).toMatchObject({ tool: "write_file", tier: 3, outcome: "denied" });
  });

  it("applies only a hunk the developer accepted", async () => {
    const wg = new FakeWriteGate();
    const { runner, audit, prompter } = setup({ root: repo.root, answer: true, writeGate: wg });
    expect((await runner.call("write_file", { hunk_id: "h1" })).ok).toBe(false);
    expect(wg.applied).toEqual([]);

    wg.accepted.add("h1");
    const out = await runner.call("write_file", { hunk_id: "h1" });
    expect(out.ok).toBe(true);
    expect(wg.applied).toEqual(["h1"]);
    expect(audit.entries()[1]).toMatchObject({ outcome: "ok", approvedBy: "accepted hunk h1" });

    expect((await runner.call("write_file", { hunk_id: "h2" })).ok).toBe(false);
    expect(wg.applied).toEqual(["h1"]);
    expect(prompter.asked).toHaveLength(0);
  });

  it("prompts, allow-lists and preApprove never unlock it", async () => {
    const wg = new FakeWriteGate();
    const { runner, gate, prompter } = setup({ root: repo.root, answer: true, allowList: ["write_file", "pytest", ""], writeGate: wg });
    gate.preApprove("write_file", { hunk_id: "h1" });
    const out = await runner.call("write_file", { hunk_id: "h1" });
    expect(out.ok).toBe(false);
    expect(wg.applied).toEqual([]);
    expect(prompter.asked).toHaveLength(0);
  });

  it("takes a hunk id, never file content", async () => {
    const wg = new FakeWriteGate();
    wg.accepted.add("h1");
    const { runner } = setup({ root: repo.root, writeGate: wg });
    const out = await runner.call("write_file", { path: "evil.py", content: "x" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("Invalid arguments");
    expect(existsSync(join(repo.root, "evil.py"))).toBe(false);
  });
});

describe("read-only tools", () => {
  it("read_file returns numbered lines and honours start/end", async () => {
    const { runner, prompter } = setup({ root: repo.root });
    const out = await runner.call("read_file", { path: "src/tiny/mathx.py", start_line: 3, end_line: 4 });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('src/tiny/mathx.py (lines 3-4 of ' + (out.data as { total_lines: number }).total_lines + ')\n3\tTRUE_VALUES = {"1", "true", "yes"}\n4\t');
    expect(prompter.asked).toHaveLength(0);
  });

  it.each(["../x", "../../etc/passwd", ".env", ".git/config", "src/.git/config", "/etc/passwd"])(
    "read_file refuses %s",
    async (p) => {
      writeFileSync(join(repo.root, ".env"), "API_KEY=sk-live-abcdefghijk\n");
      mkdirSync(join(repo.root, ".git"), { recursive: true });
      writeFileSync(join(repo.root, ".git", "config"), "[core]\n");
      const { runner, audit } = setup({ root: repo.root });
      const out = await runner.call("read_file", { path: p });
      expect(out.ok).toBe(false);
      expect(out.text).not.toContain("sk-live");
      expect(audit.entries()[0]?.outcome).toBe("denied");
    },
  );

  it("grep finds matches with a glob and never searches .env", async () => {
    writeFileSync(join(repo.root, ".env"), "SECRET_MARKER=1\n");
    const { runner } = setup({ root: repo.root });
    const out = await runner.call("grep", { pattern: "def parse_bool", path_glob: "*.py" });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^src\/tiny\/mathx\.py:\d+: def parse_bool/m);
    const env = await runner.call("grep", { pattern: "SECRET_MARKER" });
    expect(env.text).toContain("No matches");
    expect((await runner.call("grep", { pattern: "([" })).ok).toBe(false);
  });

  it("globToRegExp", () => {
    expect(globToRegExp("src/**/*.py").test("src/tiny/mathx.py")).toBe(true);
    expect(globToRegExp("src/**/*.py").test("src/a.py")).toBe(true);
    expect(globToRegExp("*.{py,toml}").test("pyproject.toml")).toBe(true);
    expect(globToRegExp("tests/*.py").test("src/tiny/mathx.py")).toBe(false);
  });

  it("list_dir lists the root without .git", async () => {
    mkdirSync(join(repo.root, ".git"), { recursive: true });
    const { runner } = setup({ root: repo.root });
    const out = await runner.call("list_dir", {});
    expect(out.ok).toBe(true);
    expect(out.text).toContain("src/");
    expect(out.text).toContain("tests/");
    expect(out.text).not.toContain(".git");
    expect((await runner.call("list_dir", { path: ".git" })).ok).toBe(false);
  });

  it("git_diff shows unstaged changes", async () => {
    execFileSync("git", ["init", "-q"], { cwd: repo.root, stdio: "pipe" });
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: repo.root, stdio: "pipe" });
    const file = join(repo.root, "src", "tiny", "mathx.py");
    writeFileSync(file, readFileSync(file, "utf8").replace('"yes"}', '"yes", "on"}'));
    const { runner } = setup({ root: repo.root });
    const out = await runner.call("git_diff", {});
    expect(out.ok).toBe(true);
    expect(out.text).toContain('+TRUE_VALUES = {"1", "true", "yes", "on"}');
  });
});

describe("apply_patch_to_shadow (tier 1)", () => {
  it("applies good.diff in memory and leaves every file byte-identical", async () => {
    const before = snapshot(repo.root);
    const { runner, prompter, audit } = setup({ root: repo.root });
    const out = await runner.call("apply_patch_to_shadow", { diff: diffFixture("good.diff") });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("2 of 2 file(s) apply cleanly");
    expect(out.text).toMatch(/ok\s+tests\/test_mathx\.py\s+\d+ -> \d+ lines/);
    expect(prompter.asked).toHaveLength(0);
    expect(audit.entries()[0]).toMatchObject({ tier: 1, approvedBy: "auto (tier 1, shadow only)", outcome: "ok" });
    const after = snapshot(repo.root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [p, buf] of before) expect(after.get(p)!.equals(buf)).toBe(true);
  });

  it("reports a conflict and refuses protected paths", async () => {
    const { runner } = setup({ root: repo.root });
    const stale = diffFixture("good.diff").replace('-TRUE_VALUES = {"1", "true", "yes"}', '-TRUE_VALUES = {"nope"}');
    const out = await runner.call("apply_patch_to_shadow", { diff: stale });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/conflict\s+src\/tiny\/mathx\.py/);

    const envDiff = "--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+X=1\n";
    const env = await runner.call("apply_patch_to_shadow", { diff: envDiff });
    expect(env.ok).toBe(false);
    expect(env.text).toMatch(/refused\s+\.env/);
    expect(existsSync(join(repo.root, ".env"))).toBe(false);
  });
});

describe("audit", () => {
  it("every call produces exactly one entry with masked args", async () => {
    const { runner, audit } = setup({ root: repo.root, answer: false });
    await runner.call("read_file", { path: "README.md" }, "panel");
    await runner.call("grep", { pattern: "ghp_abcdefghijklmnop1234" }, "mcp");
    await runner.call("run_command", { argv: ["curl", "-H", "Authorization: Bearer abcdefghijklmnop"] });
    await runner.call("write_file", { hunk_id: "h9" });
    await runner.call("no_such_tool", {});
    const entries = audit.entries();
    expect(entries.map((e) => [e.tool, e.tier, e.outcome, e.source])).toEqual([
      ["read_file", 0, "ok", "panel"],
      ["grep", 0, "ok", "mcp"],
      ["run_command", 2, "denied", "agent"],
      ["write_file", 3, "denied", "agent"],
      ["no_such_tool", 3, "denied", "agent"],
    ]);
    for (const e of entries) {
      expect(e.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(e.time))).toBe(false);
      expect(e.approvedBy).toBeTruthy();
      expect(e.args.length).toBeLessThanOrEqual(160);
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(entries[0]!.args).toBe('path="README.md"');
    expect(entries[1]!.args).toContain("ghp_****");
    expect(entries[2]!.args).toContain("Bearer ****");
    expect(JSON.stringify(entries)).not.toContain("abcdefghijklmnop");
  });
});
