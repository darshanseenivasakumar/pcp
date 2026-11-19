// Editor tools exposed to the agent (over MCP) and to the extension itself, each with a tier.
// Every call goes through ToolRunner.call: validate args -> ApprovalGate.decide -> run -> audit.
// A denied call executes nothing. No tool can write the user's files except write_file, and
// write_file only applies a hunk the developer accepted in the review panel (AGENTS.md rule 1).
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { VerifierClient } from "../api/client";
import type { Verdict } from "../contracts";
import { applyDiffToFiles, DiffParseError, HunkConflictError, parseUnifiedDiff, splitText } from "../core/diff";
import { safeResolve, UnsafePathError } from "../core/hunks";
import type { AuditLog, AuditOutcome, AuditSource } from "./audit";
import { summarizeArgs } from "./audit";
import type { ApprovalGate, Tier } from "./tiers";
import { WRITE_DENIED_REASON } from "./tiers";

export interface WriteGate {
  patchId: string;
  isAccepted(hunkId: string): boolean;
  /** Writes the accepted hunk (idempotent). */
  applyAccepted(hunkId: string): Promise<{ file: string; action: string }>;
}

export interface ToolHost {
  /** Workspace root (absolute). */
  root: string;
  verifier: Pick<VerifierClient, "verify" | "events" | "waitForVerdict">;
  /** Current task text, for run_tests. */
  task?: () => string | undefined;
  /** The open review, if any. */
  writeGate?: () => WriteGate | undefined;
}

export interface ToolSpec {
  name: string;
  title: string;
  tier: Tier;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: z.ZodRawShape;
}

export interface ToolOutput {
  ok: boolean;
  text: string;
  data?: unknown;
}

/** What the approver sees for run_tests; the "pytest" allow-list entry auto-approves it. */
export const RUN_TESTS_COMMAND = "pytest (in the PCP verifier sandbox)";

const READ_CAP = 60 * 1024;
const COMMAND_CAP = 20 * 1024;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 20_000;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", ".venv", "venv", "node_modules", "__pycache__"]);
const ENV_FILE = /^\.env(\..*)?$/;

interface Question {
  summary: string;
  command?: string;
  acceptedHunk?: string | null;
}

interface ToolDef extends ToolSpec {
  question(args: Record<string, unknown>): Question;
  run(args: Record<string, unknown>): Promise<ToolOutput>;
}

function defineTool<S extends z.ZodRawShape>(
  def: Omit<ToolSpec, "inputSchema"> & {
    inputSchema: S;
    question: (a: z.infer<z.ZodObject<S>>) => Question;
    run: (a: z.infer<z.ZodObject<S>>) => Promise<ToolOutput>;
  },
): ToolDef {
  return def as unknown as ToolDef;
}

export class ToolRunner {
  private readonly tools: Map<string, ToolDef>;

  constructor(
    private readonly host: ToolHost,
    private readonly gate: ApprovalGate,
    private readonly audit: AuditLog,
  ) {
    this.tools = new Map(buildTools(host).map((t) => [t.name, t]));
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map(({ name, title, tier, description, readOnly, destructive, inputSchema }) => ({
      name,
      title,
      tier,
      description,
      readOnly,
      destructive,
      inputSchema,
    }));
  }

  /** Decides, runs and audits one call. A denied call returns ok:false and executes nothing. */
  async call(name: string, args: Record<string, unknown>, source: AuditSource = "agent"): Promise<ToolOutput> {
    const started = Date.now();
    const raw = args ?? {};
    const record = (tier: Tier, approvedBy: string, outcome: AuditOutcome, detail?: string) =>
      this.audit.append({
        tool: name,
        tier,
        args: summarizeArgs(raw),
        approvedBy,
        outcome,
        durationMs: Date.now() - started,
        source,
        ...(detail ? { detail } : {}),
      });

    const tool = this.tools.get(name);
    if (!tool) {
      record(3, "policy: unknown tool", "denied", `no tool named ${name}`);
      return { ok: false, text: `Unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}.` };
    }
    const parsed = z.object(tool.inputSchema).safeParse(raw);
    if (!parsed.success) {
      const text = `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`;
      record(tool.tier, "policy: invalid arguments", "error", text);
      return { ok: false, text };
    }
    const a = parsed.data as Record<string, unknown>;
    const q = tool.question(a);
    const decision = await this.gate.decide({
      tool: name,
      tier: tool.tier,
      summary: q.summary,
      command: q.command,
      args: raw,
      acceptedHunk: q.acceptedHunk ?? null,
    });
    if (!decision.allowed) {
      record(tool.tier, decision.approvedBy, "denied", decision.reason ?? q.summary);
      return { ok: false, text: `Denied (${decision.approvedBy}): ${decision.reason ?? q.summary}` };
    }

    let out: ToolOutput;
    try {
      out = await tool.run(a);
    } catch (e) {
      if (e instanceof UnsafePathError) {
        record(tool.tier, "policy: unsafe path", "denied", e.message);
        return { ok: false, text: `Denied (policy): ${e.message}` };
      }
      out = { ok: false, text: `${name} failed: ${(e as Error).message ?? String(e)}` };
    }
    record(tool.tier, decision.approvedBy, out.ok ? "ok" : "error", firstLine(out.text));
    return out;
  }
}

// ------------------------------------------------------------------ the tools
function buildTools(host: ToolHost): ToolDef[] {
  const root = resolve(host.root);
  return [
    defineTool({
      name: "read_file",
      title: "Read file",
      tier: 0,
      readOnly: true,
      destructive: false,
      description:
        "Read a text file in the workspace with line numbers. Optional 1-based start_line/end_line. " +
        "Refuses .git, .env files and paths outside the workspace. Output is capped at 60 KB.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative path, e.g. src/flask/helpers.py"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      question: (a) => ({ summary: `read ${a.path}` }),
      run: async (a) => {
        const abs = await resolveInside(root, a.path);
        const stat = await statOrUndefined(abs);
        if (!stat) return { ok: false, text: `${a.path} does not exist.` };
        if (stat.isDirectory()) return { ok: false, text: `${a.path} is a directory; use list_dir.` };
        const buf = await fs.readFile(abs);
        if (buf.subarray(0, 8192).includes(0)) return { ok: false, text: `${a.path} looks binary; not shown.` };
        const { lines } = splitText(buf.toString("utf8"));
        const from = a.start_line ?? 1;
        const to = Math.min(lines.length, a.end_line ?? lines.length);
        if (lines.length > 0 && from > lines.length) {
          return { ok: false, text: `${a.path} has only ${lines.length} lines.` };
        }
        const out: string[] = [];
        let size = 0;
        let last = from - 1;
        for (let n = from; n <= to; n++) {
          const l = `${n}\t${lines[n - 1]}`;
          if (size + l.length + 1 > READ_CAP) break;
          out.push(l);
          size += l.length + 1;
          last = n;
        }
        const truncated = last < to;
        const header = `${a.path} (lines ${lines.length === 0 ? 0 : from}-${last} of ${lines.length})`;
        const tail = truncated ? `\n… truncated at 60 KB; continue with start_line=${last + 1}` : "";
        return {
          ok: true,
          text: `${header}\n${out.join("\n")}${tail}`,
          data: { path: a.path, start_line: from, end_line: last, total_lines: lines.length, truncated },
        };
      },
    }),

    defineTool({
      name: "grep",
      title: "Search files",
      tier: 0,
      readOnly: true,
      destructive: false,
      description:
        "Search workspace files with a JavaScript regular expression. Optional path_glob (e.g. *.py, " +
        "src/**/*.py). Skips .git, virtualenvs, node_modules, __pycache__ and .env files. " +
        `Returns at most ${MAX_GREP_MATCHES} matches as path:line: text.`,
      inputSchema: {
        pattern: z.string().min(1).describe("JavaScript regular expression"),
        path_glob: z.string().optional(),
      },
      question: (a) => ({ summary: `grep /${a.pattern}/${a.path_glob ? ` in ${a.path_glob}` : ""}` }),
      run: async (a) => {
        let re: RegExp;
        try {
          re = new RegExp(a.pattern);
        } catch (e) {
          return { ok: false, text: `Invalid regular expression: ${(e as Error).message}` };
        }
        const glob = a.path_glob ? globToRegExp(a.path_glob) : undefined;
        const useBase = a.path_glob !== undefined && !a.path_glob.includes("/");
        const matches: string[] = [];
        let capped = false;
        for await (const rel of walkFiles(root)) {
          if (glob && !glob.test(useBase ? basename(rel) : rel)) continue;
          const abs = join(root, rel);
          const stat = await statOrUndefined(abs);
          if (!stat || stat.size > MAX_GREP_FILE_BYTES) continue;
          const buf = await fs.readFile(abs);
          if (buf.subarray(0, 8192).includes(0)) continue;
          const { lines } = splitText(buf.toString("utf8"));
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (!re.test(line.length > 2000 ? line.slice(0, 2000) : line)) continue;
            matches.push(`${rel}:${i + 1}: ${clip(line.trim(), 200)}`);
            if (matches.length >= MAX_GREP_MATCHES) {
              capped = true;
              break;
            }
          }
          if (capped) break;
        }
        const text =
          matches.length === 0
            ? `No matches for /${a.pattern}/.`
            : matches.join("\n") + (capped ? `\n… stopped at ${MAX_GREP_MATCHES} matches; narrow the pattern or path_glob` : "");
        return { ok: true, text, data: { matches: matches.length, capped } };
      },
    }),

    defineTool({
      name: "list_dir",
      title: "List directory",
      tier: 0,
      readOnly: true,
      destructive: false,
      description: "List a workspace directory (default: the workspace root). Directories end with /.",
      inputSchema: { path: z.string().optional().describe("Workspace-relative directory, default .") },
      question: (a) => ({ summary: `list ${a.path || "."}` }),
      run: async (a) => {
        const rel = a.path?.trim() || ".";
        const abs = await resolveInside(root, rel);
        const stat = await statOrUndefined(abs);
        if (!stat) return { ok: false, text: `${rel} does not exist.` };
        if (!stat.isDirectory()) return { ok: false, text: `${rel} is a file; use read_file.` };
        const entries = (await fs.readdir(abs, { withFileTypes: true }))
          .filter((d) => d.name !== ".git")
          .sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
        const lines: string[] = [];
        for (const d of entries.slice(0, 500)) {
          if (d.isDirectory()) lines.push(`${d.name}/`);
          else if (d.isSymbolicLink()) lines.push(`${d.name} (link)`);
          else lines.push(`${d.name}  (${(await statOrUndefined(join(abs, d.name)))?.size ?? "?"} B)`);
        }
        if (entries.length > 500) lines.push(`… and ${entries.length - 500} more`);
        return {
          ok: true,
          text: `${rel}/\n${lines.join("\n") || "(empty)"}`,
          data: { path: rel, entries: entries.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)) },
        };
      },
    }),

    defineTool({
      name: "git_diff",
      title: "Show uncommitted changes",
      tier: 0,
      readOnly: true,
      destructive: false,
      description: "Show `git diff` of the workspace (unstaged changes). Read-only, no shell.",
      inputSchema: {},
      question: () => ({ summary: "git diff" }),
      run: async () => {
        await refuseShadowedExecutable(root, "git");
        const r = await runProcess(
          "git",
          ["-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color"],
          { cwd: root, timeoutMs: 15_000, cap: READ_CAP, keep: "head" },
        );
        if (r.code !== 0) return { ok: false, text: `git diff failed (${describeExit(r)}):\n${r.output}` };
        return { ok: true, text: r.output.trim() === "" ? "(no unstaged changes)" : r.output, data: { truncated: r.truncated } };
      },
    }),

    defineTool({
      name: "apply_patch_to_shadow",
      title: "Preview a patch in memory",
      tier: 1,
      readOnly: true,
      destructive: false,
      description:
        "Check that a unified diff applies to the current workspace files, entirely in memory. " +
        "Reports per file: ok / conflict and the resulting line count. Never writes to disk.",
      inputSchema: { diff: z.string().min(1).describe("Unified diff (git diff format)") },
      question: (a) => ({ summary: `preview a ${a.diff.split("\n").length}-line patch in memory` }),
      run: async (a) => shadowApply(root, a.diff),
    }),

    defineTool({
      name: "run_tests",
      title: "Run tests in the verifier sandbox",
      tier: 2,
      readOnly: false,
      destructive: false,
      description:
        "Run the project's tests on the current code and on the code with this diff applied, in the PCP " +
        "verifier's isolated sandbox (not on the user's files). Returns the verdict: decision, score, " +
        "fail-to-pass / pass-to-pass results, failing tests and repair instructions.",
      inputSchema: {
        diff: z.string().min(1).describe("Unified diff to verify"),
        task: z.string().optional().describe("Plain-English task; defaults to the current PCP task"),
      },
      question: (a) => ({
        summary: `run the tests for a ${countFiles(a.diff)}-file patch in the PCP verifier sandbox`,
        command: RUN_TESTS_COMMAND,
      }),
      run: async (a) => {
        const task = a.task?.trim() || host.task?.()?.trim() || "Run the tests for this patch.";
        const { patch_id } = await host.verifier.verify({ task, repo_root: root, diff: a.diff, attempt: 1 });
        const progress: string[] = [];
        try {
          for await (const ev of host.verifier.events(patch_id)) progress.push(`${ev.stage}/${ev.status}: ${ev.message}`);
        } catch {
          // The stream broke: the verdict is still available by polling.
        }
        const verdict = await host.verifier.waitForVerdict(patch_id, { timeoutMs: 600_000 });
        return summarizeVerdict(verdict, progress);
      },
    }),

    defineTool({
      name: "run_command",
      title: "Run a command",
      tier: 2,
      readOnly: false,
      destructive: true,
      description:
        "Run a program in the workspace root without a shell (argv list, 30 s timeout, output capped at 20 KB). " +
        "Needs the developer's approval unless it matches the allow-list (e.g. pytest, git diff).",
      inputSchema: {
        argv: z.array(z.string()).min(1).describe('Program and arguments, e.g. ["pytest", "-q", "tests"]'),
      },
      question: (a) => ({ summary: `run: ${formatArgv(a.argv)}`, command: formatArgv(a.argv) }),
      run: async (a) => {
        const [file, ...rest] = a.argv as [string, ...string[]];
        await refuseShadowedExecutable(root, file);
        const r = await runProcess(file, rest, { cwd: root, timeoutMs: 30_000, cap: COMMAND_CAP, keep: "tail" });
        return {
          ok: r.code === 0,
          text: `$ ${formatArgv(a.argv)}\n${describeExit(r)}\n${r.output}`,
          data: { exit_code: r.code, timed_out: r.timedOut, truncated: r.truncated },
        };
      },
    }),

    defineTool({
      name: "write_file",
      title: "Write an accepted hunk",
      tier: 3,
      readOnly: false,
      destructive: true,
      description:
        "Write ONE hunk to the user's files, and only a hunk the developer already accepted in the PCP " +
        "review panel. It takes a hunk id, never file content; anything else is refused.",
      inputSchema: { hunk_id: z.string().min(1).describe("Hunk id from the review panel, e.g. h2") },
      question: (a) => ({
        summary: `write accepted hunk ${a.hunk_id} to disk`,
        acceptedHunk: host.writeGate?.()?.isAccepted(a.hunk_id) ? a.hunk_id : null,
      }),
      run: async (a) => {
        const gate = host.writeGate?.();
        if (!gate || !gate.isAccepted(a.hunk_id)) return { ok: false, text: WRITE_DENIED_REASON };
        const r = await gate.applyAccepted(a.hunk_id);
        return {
          ok: true,
          text: `Applied accepted hunk ${a.hunk_id} to ${r.file} (${r.action}).`,
          data: { patch_id: gate.patchId, hunk_id: a.hunk_id, ...r },
        };
      },
    }),
  ];
}

// ------------------------------------------------------------------ helpers
/**
 * safeResolve plus: no `.git` segment anywhere, and a symlink may not lead outside the
 * workspace or onto a protected file.
 */
async function resolveInside(root: string, relPath: string): Promise<string> {
  const abs = safeResolve(root, relPath);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.split("/").includes(".git")) throw new UnsafePathError(relPath, "protected path");
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return abs;
    throw e;
  }
  const realRoot = await fs.realpath(root);
  const realRel = relative(realRoot, real);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new UnsafePathError(relPath, "it links outside the workspace");
  }
  if (realRel !== "") safeResolve(realRoot, realRel); // a link onto .env / .git is refused too
  return abs;
}

async function statOrUndefined(abs: string) {
  try {
    return await fs.stat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Workspace-relative POSIX paths of regular files, skipping vendored and protected entries. */
async function* walkFiles(root: string): AsyncGenerator<string> {
  const stack = [""];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const d of entries) {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) subdirs.push(rel);
      } else if (d.isFile() && !ENV_FILE.test(d.name)) {
        if (++seen > MAX_GREP_FILES) return;
        yield rel;
      }
    }
    stack.push(...subdirs.reverse());
  }
}

/** Minimal glob: *, ?, **, {a,b}. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${re}${")".repeat(depth)}$`);
}

interface ProcResult {
  code: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

/** execFile without a shell. Never rejects: spawn errors come back as code null. */
function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; cap: number; keep: "head" | "tail" },
): Promise<ProcResult> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
        let output = [stdout, stderr].filter((s) => s && s.length > 0).join(stdout && stderr ? "\n" : "");
        let code: number | null = 0;
        if (e) {
          code = typeof e.code === "number" ? e.code : null;
          if (typeof e.code === "string" && output === "") output = `could not start ${file}: ${e.message}`;
        }
        const truncated = output.length > opts.cap;
        if (truncated) {
          output =
            opts.keep === "head"
              ? `${output.slice(0, opts.cap)}\n… output truncated at ${Math.round(opts.cap / 1024)} KB`
              : `… first ${output.length - opts.cap} characters omitted\n${output.slice(-opts.cap)}`;
        }
        done({
          code,
          signal: e?.signal ?? null,
          output,
          timedOut: Boolean(e?.killed) && code === null,
          truncated,
        });
      },
    );
  });
}

function describeExit(r: ProcResult): string {
  if (r.timedOut) return "timed out (killed)";
  if (r.code === null) return r.signal ? `killed by ${r.signal}` : "did not start";
  return `exit ${r.code}`;
}

/**
 * On Windows a bare program name is looked up in the working directory before PATH, so a
 * workspace that ships git.exe or pytest.exe would run instead of the real tool.
 */
async function refuseShadowedExecutable(root: string, file: string): Promise<void> {
  if (process.platform !== "win32" || /[\\/]/.test(file)) return;
  for (const ext of ["", ".exe", ".com"]) {
    const candidate = join(root, `${file}${ext}`);
    const st = await statOrUndefined(candidate);
    if (st?.isFile() && (ext !== "" || /\.(exe|com)$/i.test(file))) {
      throw new Error(`refusing to run ${file}: the workspace contains ${file}${ext}, which would run instead of the installed program`);
    }
  }
}

function formatArgv(argv: string[]): string {
  return argv.map((a) => (a === "" || /[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

function countFiles(diff: string): number {
  try {
    return parseUnifiedDiff(diff, { recount: true }).files.length;
  } catch {
    return 0;
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function firstLine(s: string): string {
  return clip(s.split("\n", 1)[0] ?? "", 200);
}

interface ShadowFileResult {
  file: string;
  status: "ok" | "conflict" | "refused";
  hunks: string[];
  lines_before: number;
  lines_after: number;
  error?: string;
}

async function shadowApply(root: string, diffText: string): Promise<ToolOutput> {
  let parsed;
  try {
    parsed = parseUnifiedDiff(diffText, { recount: true });
  } catch (e) {
    if (e instanceof DiffParseError) return { ok: false, text: `Not a valid unified diff: ${e.message}` };
    throw e;
  }
  if (parsed.files.length === 0) return { ok: false, text: "No file changes found in the diff." };

  const results: ShadowFileResult[] = [];
  for (const f of parsed.files) {
    const r: ShadowFileResult = { file: f.path, status: "ok", hunks: f.hunks.map((h) => h.hunk_id), lines_before: 0, lines_after: 0 };
    results.push(r);
    try {
      for (const p of new Set([f.path, f.oldPath, f.newPath])) if (p) await resolveInside(root, p);
      const source = f.isNew ? null : (f.oldPath ?? f.path);
      const files = new Map<string, string>();
      if (source) {
        const abs = await resolveInside(root, source);
        const st = await statOrUndefined(abs);
        if (!st?.isFile()) throw new HunkConflictError(r.hunks[0] ?? "-", f.path, "the file does not exist");
        const content = await fs.readFile(abs, "utf8");
        files.set(source, content);
        r.lines_before = splitText(content).lines.length;
      } else if (await statOrUndefined(await resolveInside(root, f.path))) {
        throw new HunkConflictError(r.hunks[0] ?? "-", f.path, "the diff creates it but it already exists");
      }
      const after = applyDiffToFiles(files, { files: [f], hunks: f.hunks }).get(f.isDeleted ? (source ?? f.path) : f.path);
      r.lines_after = after ? splitText(after).lines.length : 0;
    } catch (e) {
      r.status = e instanceof UnsafePathError ? "refused" : "conflict";
      r.error = (e as Error).message;
    }
  }
  const good = results.filter((r) => r.status === "ok").length;
  const lines = results.map((r) =>
    r.status === "ok"
      ? `ok        ${r.file}  ${r.lines_before} -> ${r.lines_after} lines (${r.hunks.join(", ")})`
      : `${r.status.padEnd(9)} ${r.file}: ${r.error}`,
  );
  return {
    ok: good === results.length,
    text: `Shadow apply: ${good} of ${results.length} file(s) apply cleanly. Nothing was written to disk.\n${lines.join("\n")}`,
    data: { files: results },
  };
}

function summarizeVerdict(v: Verdict, progress: string[]): ToolOutput {
  const proof = v.proof ?? undefined;
  const failing = Object.entries(proof?.patched?.tests ?? {})
    .filter(([, outcome]) => outcome === "failed" || outcome === "error")
    .map(([id]) => id);
  const lines = [
    `Verdict: ${v.decision} (score ${v.score}${v.unproven ? ", unproven" : ""}, attempt ${v.attempt})`,
    v.decision_reason,
    `Fail-to-pass ok: ${proof ? proof.f2p_ok : "n/a"}; pass-to-pass ok: ${proof ? proof.p2p_ok : "n/a"}`,
  ];
  if (proof?.patched) lines.push(`Patched run: ${proof.patched.passed} passed, ${proof.patched.failed} failed`);
  if (failing.length > 0) {
    lines.push(`Failing tests (${failing.length}):`, ...failing.slice(0, 30).map((t) => `  ${t}`));
    if (failing.length > 30) lines.push(`  … and ${failing.length - 30} more`);
  }
  if (v.repair_instructions) lines.push("Repair instructions:", v.repair_instructions);
  if (progress.length > 0) lines.push(`Stages: ${progress.join(" | ")}`);
  return {
    ok: true,
    text: lines.join("\n"),
    data: {
      patch_id: v.patch_id,
      decision: v.decision,
      score: v.score,
      unproven: v.unproven,
      f2p_ok: proof?.f2p_ok ?? null,
      p2p_ok: proof?.p2p_ok ?? null,
      failing,
      repair_instructions: v.repair_instructions ?? null,
    },
  };
}
