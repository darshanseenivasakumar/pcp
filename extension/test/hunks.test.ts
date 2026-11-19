// "Accept writes only that hunk; reject writes nothing" (AGENTS.md 7.2), judged by git itself.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HunkConflictError, parseUnifiedDiff } from "../src/core/diff";
import type { WorkspaceFs } from "../src/core/hunks";
import { HunkReview, nodeWorkspaceFs, safeResolve, UnsafePathError } from "../src/core/hunks";

const TINY = join(__dirname, "..", "..", "fixtures", "tiny_repo");
const diffText = (name: string) => readFileSync(join(TINY, "diffs", name), "utf8");

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const status = () => git("status", "--porcelain").trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pcp-hunks-"));
  cpSync(TINY, repo, { recursive: true, filter: (src) => !src.includes(`${join("tiny_repo", "diffs")}`) });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Counts writes so "reject writes nothing" is checked at the fs boundary too. */
function spyFs(inner: WorkspaceFs) {
  const calls: string[] = [];
  return {
    calls,
    fs: {
      read: inner.read,
      write: async (p: string, c: string) => {
        calls.push(`write ${p}`);
        await inner.write(p, c);
      },
      remove: async (p: string) => {
        calls.push(`remove ${p}`);
        await inner.remove(p);
      },
    } satisfies WorkspaceFs,
  };
}

describe("HunkReview", () => {
  it("accept writes only that hunk", async () => {
    const review = new HunkReview(nodeWorkspaceFs(repo), parseUnifiedDiff(diffText("good.diff")));
    const w = await review.accept("h2");
    expect(w.file).toBe("tests/test_mathx.py");
    expect(status()).toBe("M tests/test_mathx.py");
    expect(git("diff", "--", "src")).toBe("");
    expect(review.all()).toEqual({ h1: "pending", h2: "accepted" });
  });

  it("reject writes nothing", async () => {
    const spy = spyFs(nodeWorkspaceFs(repo));
    const review = new HunkReview(spy.fs, parseUnifiedDiff(diffText("good.diff")));
    review.reject("h1");
    review.reject("h2");
    expect(spy.calls).toEqual([]);
    expect(status()).toBe("");
  });

  it("accepting every hunk (in any order) equals git apply of the whole diff", async () => {
    const review = new HunkReview(nodeWorkspaceFs(repo), parseUnifiedDiff(diffText("fixable_v2.diff")));
    await review.accept("h2");
    await review.accept("h1");
    await review.accept("h1"); // idempotent
    const ours = git("diff");
    git("checkout", "--", ".");
    execFileSync("git", ["apply", "-"], { cwd: repo, input: diffText("fixable_v2.diff") });
    expect(ours).toBe(git("diff"));
  });

  it("a conflicting hunk writes nothing and stays pending", async () => {
    const spy = spyFs(nodeWorkspaceFs(repo));
    const review = new HunkReview(spy.fs, parseUnifiedDiff(diffText("good.diff")));
    const path = join(repo, "src", "tiny", "mathx.py");
    const edited = readFileSync(path, "utf8").replace('{"1", "true", "yes"}', "set()");
    await nodeWorkspaceFs(repo).write("src/tiny/mathx.py", edited);
    await expect(review.accept("h1")).rejects.toBeInstanceOf(HunkConflictError);
    expect(spy.calls).toEqual([]);
    expect(review.state("h1")).toBe("pending");
  });

  it("refuses protected paths and paths outside the workspace", () => {
    expect(() => safeResolve(repo, "../evil.py")).toThrow(UnsafePathError);
    expect(() => safeResolve(repo, ".git/config")).toThrow(UnsafePathError);
    expect(() => safeResolve(repo, "app/.env")).toThrow(UnsafePathError);
    expect(safeResolve(repo, "src/tiny/mathx.py")).toBe(join(repo, "src", "tiny", "mathx.py"));
  });
});
