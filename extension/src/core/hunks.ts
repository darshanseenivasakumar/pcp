// Per-hunk review: the ONLY path by which a verified patch reaches the user's files
// (AGENTS.md rule 1). Accept writes exactly one hunk; Reject writes nothing.
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

import type { FilePatch, ParsedDiff, ParsedHunk } from "./diff";
import { applyHunk, hunkDelta, HunkConflictError } from "./diff";

/** File access relative to the workspace root. Implementations must refuse paths outside it. */
export interface WorkspaceFs {
  read(relPath: string): Promise<string | undefined>;
  write(relPath: string, content: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

export type HunkState = "pending" | "accepted" | "rejected";

export interface HunkWrite {
  hunkId: string;
  file: string;
  action: "write" | "delete";
  bytes: number;
}

/** Paths an agent patch may never write, even through an accepted hunk. */
const PROTECTED = [/^\.git(\/|$)/, /(^|\/)\.env(\..*)?$/];

export class UnsafePathError extends Error {
  constructor(path: string, why: string) {
    super(`refusing to touch ${path}: ${why}`);
    this.name = "UnsafePathError";
  }
}

/** Resolves a diff path inside `root`, or throws. Returns the absolute path. */
export function safeResolve(root: string, relPath: string): string {
  const clean = normalize(relPath).replace(/\\/g, "/");
  if (isAbsolute(relPath) || clean.startsWith("../") || clean === "..") {
    throw new UnsafePathError(relPath, "outside the workspace");
  }
  if (PROTECTED.some((re) => re.test(clean))) throw new UnsafePathError(relPath, "protected path");
  const abs = resolve(root, clean);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new UnsafePathError(relPath, "outside the workspace");
  return abs;
}

export function nodeWorkspaceFs(root: string): WorkspaceFs {
  return {
    async read(p) {
      try {
        return await fs.readFile(safeResolve(root, p), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    async write(p, content) {
      const abs = safeResolve(root, p);
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    },
    async remove(p) {
      await fs.rm(safeResolve(root, p), { force: true });
    },
  };
}

export class HunkReview {
  private readonly states = new Map<string, HunkState>();
  private readonly byId = new Map<string, { hunk: ParsedHunk; file: FilePatch }>();

  constructor(
    private readonly fs: WorkspaceFs,
    readonly diff: ParsedDiff,
  ) {
    for (const file of diff.files) {
      for (const hunk of file.hunks) {
        this.byId.set(hunk.hunk_id, { hunk, file });
        this.states.set(hunk.hunk_id, "pending");
      }
    }
  }

  state(hunkId: string): HunkState {
    const s = this.states.get(hunkId);
    if (!s) throw new Error(`unknown hunk ${hunkId}`);
    return s;
  }

  all(): Record<string, HunkState> {
    return Object.fromEntries(this.states);
  }

  isAccepted(hunkId: string): boolean {
    return this.states.get(hunkId) === "accepted";
  }

  /** Marks the hunk rejected. Never touches the disk. */
  reject(hunkId: string): void {
    if (this.state(hunkId) === "accepted") throw new Error(`${hunkId} is already on disk; undo it with Ctrl+Z / git`);
    this.states.set(hunkId, "rejected");
  }

  /**
   * Writes exactly this hunk to disk. Idempotent. On a conflict nothing is written and the hunk
   * stays pending. Hunks of the same file may be accepted in any order: the line offset from
   * already-accepted hunks above it is applied, and the hunk's old lines must still match.
   */
  async accept(hunkId: string): Promise<HunkWrite> {
    const entry = this.byId.get(hunkId);
    if (!entry) throw new Error(`unknown hunk ${hunkId}`);
    const { hunk, file } = entry;
    if (file.isBinary) throw new HunkConflictError(hunkId, file.path, "binary patches cannot be applied per hunk");
    if (this.state(hunkId) === "accepted") return { hunkId, file: file.path, action: "write", bytes: 0 };

    const source = file.isNew ? file.path : (file.oldPath ?? file.path);
    let current = await this.fs.read(this.anyAccepted(file) ? file.path : source);
    if (current === undefined) {
      if (!file.isNew) throw new HunkConflictError(hunkId, file.path, "the file does not exist");
      current = "";
    }
    const offset = file.hunks
      .filter((h) => h !== hunk && this.isAccepted(h.hunk_id) && h.old_start < hunk.old_start)
      .reduce((sum, h) => sum + hunkDelta(h), 0);
    const next = applyHunk(current, hunk, offset); // throws before any write

    this.states.set(hunkId, "accepted");
    const allAccepted = file.hunks.every((h) => this.isAccepted(h.hunk_id));
    if (file.isDeleted && allAccepted && next === "") {
      await this.fs.remove(source);
      return { hunkId, file: source, action: "delete", bytes: 0 };
    }
    try {
      await this.fs.write(file.path, next);
    } catch (e) {
      this.states.set(hunkId, "pending");
      throw e;
    }
    return { hunkId, file: file.path, action: "write", bytes: Buffer.byteLength(next) };
  }

  private anyAccepted(file: FilePatch): boolean {
    return file.hunks.some((h) => this.isAccepted(h.hunk_id));
  }
}
