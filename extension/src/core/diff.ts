// Unified-diff parsing and per-hunk application.
//
// Hunk ids are `h1..hN`, numbered in diff order across all files. The verifier keys
// `hunk_evidence` the same way (see QUESTIONS.md), so the review panel can show each hunk's
// tests and findings next to it.
import type { Hunk } from "../contracts";

export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
}

export interface ParsedHunk extends Hunk {
  /** Text after the second @@ (usually the enclosing function). */
  section: string;
  lines: DiffLine[];
  /** "\ No newline at end of file" after the last old-side / new-side line. */
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export interface FilePatch {
  oldPath: string | null; // null => new file (/dev/null)
  newPath: string | null; // null => deleted file
  /** Path the hunks apply to: the new path, or the old path for deletions. */
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  /** Extra git header lines (mode changes, renames, index). */
  meta: string[];
  hunks: ParsedHunk[];
}

export interface ParsedDiff {
  files: FilePatch[];
  hunks: ParsedHunk[];
}

export class DiffParseError extends Error {
  constructor(message: string, readonly lineNo: number) {
    super(`diff line ${lineNo}: ${message}`);
    this.name = "DiffParseError";
  }
}

export class HunkConflictError extends Error {
  constructor(readonly hunkId: string, readonly file: string, detail: string) {
    super(`${hunkId} no longer applies to ${file}: ${detail}`);
    this.name = "HunkConflictError";
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(p: string): string | null {
  let s = p.trim();
  const tab = s.indexOf("\t"); // "--- a/x.py\t2024-01-01 ..." timestamps
  if (tab !== -1) s = s.slice(0, tab);
  if (s.startsWith('"') && s.endsWith('"')) s = JSON.parse(s) as string;
  if (s === "/dev/null") return null;
  return s.replace(/^[ab]\//, "");
}

export interface ParseOptions {
  /**
   * Model-written diffs often carry wrong @@ line counts. With recount, a hunk body runs until
   * the next header and the counts are recomputed (like `git apply --recount`).
   */
  recount?: boolean;
}

export function parseUnifiedDiff(text: string, opts: ParseOptions = {}): ParsedDiff {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const files: FilePatch[] = [];
  const hunks: ParsedHunk[] = [];
  let file: FilePatch | undefined;
  let hunk: ParsedHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;

  const newFile = (oldPath: string | null, newPath: string | null): FilePatch => {
    const f: FilePatch = {
      oldPath,
      newPath,
      path: newPath ?? oldPath ?? "",
      isNew: oldPath === null,
      isDeleted: newPath === null,
      isBinary: false,
      meta: [],
      hunks: [],
    };
    files.push(f);
    return f;
  };

  const closeHunk = (lineNo: number) => {
    if (!hunk) return;
    if (opts.recount) {
      hunk.old_lines = hunk.lines.filter((l) => l.kind !== "+").length;
      hunk.new_lines = hunk.lines.filter((l) => l.kind !== "-").length;
    } else if (oldLeft !== 0 || newLeft !== 0) {
      throw new DiffParseError(`${hunk.hunk_id} in ${hunk.file} is shorter than its @@ header says`, lineNo);
    }
    hunk = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const inBody = hunk && (opts.recount || oldLeft > 0 || newLeft > 0);

    if (inBody) {
      const isHeader =
        line.startsWith("diff --git ") ||
        line.startsWith("@@ ") ||
        (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ "));
      const c = line[0];
      if (!(opts.recount && isHeader)) {
        if (c === "\\") {
          const prev = hunk!.lines[hunk!.lines.length - 1];
          if (prev?.kind !== "+") hunk!.oldNoNewline = true;
          if (prev?.kind !== "-") hunk!.newNoNewline = true;
          continue;
        }
        if (c === " " || c === "-" || c === "+" || line === "") {
          const kind = (line === "" ? " " : c) as DiffLine["kind"];
          hunk!.lines.push({ kind, text: line.slice(1) });
          if (kind !== "+") oldLeft--;
          if (kind !== "-") newLeft--;
          if (!opts.recount && (oldLeft < 0 || newLeft < 0)) {
            throw new DiffParseError(`${hunk!.hunk_id} in ${hunk!.file} is longer than its @@ header says`, lineNo);
          }
          continue;
        }
        if (!opts.recount) {
          throw new DiffParseError(`unexpected line inside ${hunk!.hunk_id}: ${JSON.stringify(line.slice(0, 40))}`, lineNo);
        }
      }
    }
    // A trailing "\ No newline" right after a hunk whose counts ran out.
    if (hunk && line.startsWith("\\")) {
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev?.kind !== "+") hunk.oldNoNewline = true;
      if (prev?.kind !== "-") hunk.newNoNewline = true;
      continue;
    }
    closeHunk(lineNo);

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      file = newFile(m ? stripPrefix(m[1]!) : null, m ? stripPrefix(m[2]!) : null);
      file.isNew = false;
      file.isDeleted = false;
      continue;
    }
    if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      const oldPath = stripPrefix(line.slice(4));
      const newPath = stripPrefix(lines[i + 1]!.slice(4));
      if (!file || file.hunks.length > 0 || file.meta.includes("+++")) file = newFile(oldPath, newPath);
      file.oldPath = oldPath;
      file.newPath = newPath;
      file.path = newPath ?? oldPath ?? file.path;
      file.isNew = oldPath === null;
      file.isDeleted = newPath === null;
      file.meta.push("+++");
      i++;
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (!file) throw new DiffParseError("@@ hunk before any file header", lineNo);
      hunk = {
        hunk_id: `h${hunks.length + 1}`,
        file: file.path,
        old_start: Number(hm[1]),
        old_lines: hm[2] === undefined ? 1 : Number(hm[2]),
        new_start: Number(hm[3]),
        new_lines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: hm[5] ?? "",
        lines: [],
        oldNoNewline: false,
        newNoNewline: false,
      };
      oldLeft = hunk.old_lines;
      newLeft = hunk.new_lines;
      file.hunks.push(hunk);
      hunks.push(hunk);
      continue;
    }
    if (file && /^(new|deleted) file mode|^(old|new) mode|^index |^similarity index|^rename (from|to) |^copy (from|to) /.test(line)) {
      if (line.startsWith("new file mode")) file.isNew = true;
      if (line.startsWith("deleted file mode")) file.isDeleted = true;
      file.meta.push(line);
      continue;
    }
    if (file && /^Binary files .* differ$|^GIT binary patch$/.test(line)) {
      file.isBinary = true;
      continue;
    }
    // Anything else between files (commit message, prose around a model's diff) is ignored.
  }
  closeHunk(lines.length);
  for (const f of files) f.meta = f.meta.filter((m) => m !== "+++");
  return { files: files.filter((f) => f.hunks.length > 0 || f.isBinary || f.meta.length > 0), hunks };
}

/** Canonical text for a parsed diff (counts fixed). Hunk ids survive a parse/serialize round trip. */
export function serializeDiff(diff: ParsedDiff): string {
  const out: string[] = [];
  for (const f of diff.files) {
    const a = f.oldPath ?? f.newPath ?? f.path;
    const b = f.newPath ?? f.oldPath ?? f.path;
    out.push(`diff --git a/${a} b/${b}`);
    out.push(...f.meta.filter((m) => !m.startsWith("index ")));
    if (f.isNew && !f.meta.some((m) => m.startsWith("new file mode"))) out.push("new file mode 100644");
    if (f.isDeleted && !f.meta.some((m) => m.startsWith("deleted file mode"))) out.push("deleted file mode 100644");
    if (f.hunks.length === 0) continue;
    out.push(`--- ${f.oldPath === null ? "/dev/null" : `a/${f.oldPath}`}`);
    out.push(`+++ ${f.newPath === null ? "/dev/null" : `b/${f.newPath}`}`);
    for (const h of f.hunks) {
      out.push(`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@${h.section ? ` ${h.section}` : ""}`);
      const lastOld = findLast(h.lines, (l) => l.kind !== "+");
      const lastNew = findLast(h.lines, (l) => l.kind !== "-");
      for (const l of h.lines) {
        out.push(`${l.kind}${l.text}`);
        const markOld = h.oldNoNewline && l === lastOld;
        const markNew = h.newNoNewline && l === lastNew;
        if (markOld || markNew) out.push("\\ No newline at end of file");
      }
    }
  }
  return out.join("\n") + "\n";
}

function findLast<T>(xs: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return xs[i];
  return undefined;
}

// ------------------------------------------------------------------ applying hunks
interface Text {
  lines: string[];
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

export function splitText(content: string): Text {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (content === "") return { lines: [], eol, finalNewline: true };
  const lines = content.split(/\r?\n/);
  const finalNewline = lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

export function joinText(t: Text): string {
  if (t.lines.length === 0) return "";
  return t.lines.join(t.eol) + (t.finalNewline ? t.eol : "");
}

/** Line delta a hunk introduces (positive = file grows). */
export const hunkDelta = (h: Hunk): number => h.new_lines - h.old_lines;

/**
 * Applies one hunk to `content`. `offset` is the line shift caused by hunks of the same file
 * that were already applied above this one. If the old lines are not at the expected spot,
 * the nearest exact match is used; if there is none, HunkConflictError is thrown and nothing
 * is changed.
 */
export function applyHunk(content: string, hunk: ParsedHunk, offset = 0): string {
  const t = splitText(content);
  const oldSide = hunk.lines.filter((l) => l.kind !== "+").map((l) => l.text);
  const newSide = hunk.lines.filter((l) => l.kind !== "-").map((l) => l.text);
  // old_start is 1-based; a pure insertion (old_lines 0) inserts after line old_start.
  const expected = (hunk.old_lines === 0 ? hunk.old_start : hunk.old_start - 1) + offset;
  const at = locate(t.lines, oldSide, expected);
  if (at === -1) {
    throw new HunkConflictError(hunk.hunk_id, hunk.file, "the lines it changes are not in the file any more");
  }
  const endsAtEof = at + oldSide.length === t.lines.length;
  t.lines.splice(at, oldSide.length, ...newSide);
  if (endsAtEof && newSide.length > 0) t.finalNewline = !hunk.newNoNewline;
  return joinText(t);
}

function matchesAt(lines: string[], needle: string[], at: number): boolean {
  if (at < 0 || at + needle.length > lines.length) return false;
  for (let i = 0; i < needle.length; i++) if (lines[at + i] !== needle[i]) return false;
  return true;
}

function locate(lines: string[], needle: string[], expected: number): number {
  if (needle.length === 0) return Math.min(Math.max(expected, 0), lines.length);
  if (matchesAt(lines, needle, expected)) return expected;
  for (let d = 1; d <= lines.length; d++) {
    if (matchesAt(lines, needle, expected - d)) return expected - d;
    if (matchesAt(lines, needle, expected + d)) return expected + d;
  }
  return -1;
}

/** Applies several hunks of one file to `content`, in file order. */
export function applyHunks(content: string, hunks: ParsedHunk[]): string {
  let out = content;
  let offset = 0;
  for (const h of [...hunks].sort((a, b) => a.old_start - b.old_start)) {
    out = applyHunk(out, h, offset);
    offset += hunkDelta(h);
  }
  return out;
}

/** Applies every hunk in the diff to an in-memory file map (used for shadow previews). */
export function applyDiffToFiles(files: Map<string, string>, diff: ParsedDiff): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const f of diff.files) {
    if (f.isBinary) throw new HunkConflictError("-", f.path, "binary patches are not supported");
    const before = f.isNew ? "" : files.get(f.oldPath ?? f.path);
    if (before === undefined) throw new HunkConflictError(f.hunks[0]?.hunk_id ?? "-", f.path, "file does not exist");
    const after = applyHunks(before, f.hunks);
    if (f.isDeleted) out.set(f.oldPath ?? f.path, null);
    else out.set(f.path, after);
  }
  return out;
}
