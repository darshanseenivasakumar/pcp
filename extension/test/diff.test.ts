import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyHunk,
  applyHunks,
  DiffParseError,
  HunkConflictError,
  parseUnifiedDiff,
  serializeDiff,
} from "../src/core/diff";

const ROOT = join(__dirname, "..", "..");
const tiny = (p: string) => readFileSync(join(ROOT, "fixtures", "tiny_repo", p), "utf8");

describe("parseUnifiedDiff", () => {
  it("numbers hunks h1..hN in diff order across files", () => {
    const d = parseUnifiedDiff(tiny("diffs/good.diff"));
    expect(d.files.map((f) => f.path)).toEqual(["src/tiny/mathx.py", "tests/test_mathx.py"]);
    expect(d.hunks.map((h) => [h.hunk_id, h.file, h.old_start, h.old_lines, h.new_start, h.new_lines])).toEqual([
      ["h1", "src/tiny/mathx.py", 1, 6, 1, 6],
      ["h2", "tests/test_mathx.py", 31, 3, 31, 8],
    ]);
    expect(d.hunks[0]!.lines.filter((l) => l.kind === "+").map((l) => l.text)).toEqual([
      'TRUE_VALUES = {"1", "true", "yes", "on"}',
    ]);
    expect(d.hunks[1]!.section).toBe("def test_safe_div():");
  });

  it("parses deletions and multi-file diffs", () => {
    const d = parseUnifiedDiff(tiny("diffs/malicious.diff"));
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[1]!.lines.filter((l) => l.kind === "-")).toHaveLength(5);
  });

  it("fails loudly on wrong @@ counts, and recounts model-written diffs on request", () => {
    const bad = [
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -1,3 +1,4 @@",
      " a",
      "+b",
      " c",
      "",
    ].join("\n");
    expect(() => parseUnifiedDiff(bad)).toThrow(DiffParseError);
    const d = parseUnifiedDiff(bad, { recount: true });
    expect([d.hunks[0]!.old_lines, d.hunks[0]!.new_lines]).toEqual([2, 3]);
  });

  it("ignores prose around a model's diff and handles new / deleted files", () => {
    const text = [
      "Here is my patch:",
      "diff --git a/new.py b/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1,2 @@",
      "+x = 1",
      "+y = 2",
      "diff --git a/old.py b/old.py",
      "deleted file mode 100644",
      "--- a/old.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "Hope this helps!",
    ].join("\n");
    const d = parseUnifiedDiff(text);
    expect(d.files.map((f) => [f.path, f.isNew, f.isDeleted])).toEqual([
      ["new.py", true, false],
      ["old.py", false, true],
    ]);
  });

  it("serialize -> parse keeps hunk ids and counts", () => {
    const d = parseUnifiedDiff(tiny("diffs/fixable.diff"));
    const again = parseUnifiedDiff(serializeDiff(d));
    expect(again.hunks.map((h) => [h.hunk_id, h.file, h.old_lines, h.new_lines])).toEqual(
      d.hunks.map((h) => [h.hunk_id, h.file, h.old_lines, h.new_lines]),
    );
  });
});

describe("applyHunk", () => {
  it("applies each hunk of the good diff", () => {
    const d = parseUnifiedDiff(tiny("diffs/good.diff"));
    expect(applyHunk(tiny("src/tiny/mathx.py"), d.hunks[0]!)).toContain('"yes", "on"}');
    expect(applyHunk(tiny("tests/test_mathx.py"), d.hunks[1]!)).toMatch(/def test_parse_bool_on\(value\):\n {4}assert/);
  });

  it("finds a hunk that moved, and refuses one whose lines are gone", () => {
    const d = parseUnifiedDiff(tiny("diffs/good.diff"));
    const shifted = "# a new header line\n# another\n" + tiny("src/tiny/mathx.py");
    expect(applyHunk(shifted, d.hunks[0]!)).toContain('"yes", "on"}');
    const edited = tiny("src/tiny/mathx.py").replace('TRUE_VALUES = {"1", "true", "yes"}', "TRUE_VALUES = set()");
    expect(() => applyHunk(edited, d.hunks[0]!)).toThrow(HunkConflictError);
  });

  it("keeps CRLF line endings and the final-newline state", () => {
    const d = parseUnifiedDiff(tiny("diffs/good.diff"));
    const crlf = tiny("src/tiny/mathx.py").replace(/\n/g, "\r\n");
    const out = applyHunk(crlf, d.hunks[0]!);
    expect(out).toContain('"on"}\r\n');
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("applies several hunks of one file with line offsets", () => {
    const base = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    const diff = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -2,1 +2,3 @@",
      "-line2",
      "+two",
      "+two-b",
      "+two-c",
      "@@ -20,1 +22,1 @@",
      "-line20",
      "+twenty",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(diff);
    const out = applyHunks(base, d.hunks);
    expect(out.split("\n").slice(0, 4)).toEqual(["line1", "two", "two-b", "two-c"]);
    expect(out.split("\n")[21]).toBe("twenty");
  });
});
