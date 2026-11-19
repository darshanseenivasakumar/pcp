/**
 * Context assembly (rubric B1): pick the files a coding agent should read for a
 * task, say WHY each one was picked, and fit them into a token budget.
 *
 * Pure Node, no `vscode` import, deterministic, plain regex (no parser deps).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface RepoReader {
  listFiles(): Promise<string[]>; // repo-relative POSIX paths
  read(path: string): Promise<string | undefined>;
}

export interface ContextRequest {
  task: string;
  focusFile?: string;
  selection?: { startLine: number; endLine: number; text: string };
  budgetTokens: number; // tokens ~= ceil(chars / 4)
}

export interface ContextItem {
  path: string;
  reasons: string[];
  score: number;
  tokens: number;
  content: string;
  excerpt?: { startLine: number; endLine: number }; // 1-based
}

export interface ContextBundle {
  items: ContextItem[];
  dropped: { path: string; reasons: string[]; tokens: number }[];
  totalTokens: number;
  budgetTokens: number;
  symbols: string[];
}

// ---------------------------------------------------------------- weights

const W = {
  selected: 100,
  defines: 50,
  definesExtra: 10,
  tests: 30,
  pathMatch: 35, // above tests: for "add a `flask config` command" the cli.py source matters most
  pathMatchData: 5, // config.yml / config.json style files
  imports: 15,
  importedBy: 12,
  documents: 10,
  mentions: 5,
} as const;

const MAX_MENTIONS = 8;
const MAX_IMPORT_EXPANSION = 8;
const MAX_DOCS = 6;
const MAX_DROPPED = 20;
const EXCERPT_RADIUS = 30;
const MAX_FILE_SHARE = 0.35;

const STOPWORDS = new Set(
  (
    "the a an and or but if then else for from into onto with without that this those these also too " +
    "make makes made add adds added use uses used get gets set sets show shows treat treats " +
    "test tests docs doc documentation value values code file files function functions method class " +
    "command commands new old all any each every some not only just should must can will would could " +
    "it its is are was were be been to of in on at by as so such than when where which what who how " +
    "please update change changes fix need needs want like app apps true false none null " +
    "string strings name names mask masks masked secret secrets configuration"
  ).split(/\s+/),
);

// ---------------------------------------------------------------- symbols

function isStop(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

function pushSym(out: string[], s: string): void {
  const sym = s.replace(/^[._]+|[.]+$/g, "");
  if (sym.length < 2) return;
  // Reduce dotted identifiers (flask.helpers.get_debug_flag) to the last segment.
  const last = sym.includes(".") ? (sym.split(".").pop() ?? sym) : sym;
  if (last.length < 2 || isStop(last) || out.includes(last)) return;
  out.push(last);
}

export function extractSymbols(task: string, selectionText?: string): string[] {
  const out: string[] = [];

  // 1. Backticked spans: `get_debug_flag`, `flask config` (drop the command prefix).
  for (const m of task.matchAll(/`([^`\n]+)`/g)) {
    const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const use = words.length > 1 && /^[a-z]+$/.test(words[0] ?? "") ? words.slice(1) : words;
    for (const w of use) {
      const clean = w.replace(/[^A-Za-z0-9_.]/g, "");
      if (clean) pushSym(out, clean);
    }
  }

  // 2. Identifiers in the prose (quoted values like "off" are data, not symbols).
  const prose = task
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
  for (const m of prose.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const tok = m[0];
    const last = tok.split(".").pop() ?? tok;
    const snake = last.includes("_");
    const camel = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(last) || /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(last);
    const acronym = /^[A-Z]{2,5}$/.test(last);
    if (snake || camel || acronym) pushSym(out, tok);
  }

  // 3. Code-ish identifiers in the selection (no plain words, too noisy).
  if (selectionText) {
    for (const m of selectionText.matchAll(/\b(?:def|class)\s+([A-Za-z_]\w*)/g)) pushSym(out, m[1] ?? "");
    for (const m of selectionText.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const t = m[0];
      if (t.includes("_") && t.length > 3 && !t.startsWith("__")) pushSym(out, t);
      else if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(t)) pushSym(out, t);
    }
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------- python index

interface PyInfo {
  defs: Set<string>;
  imports: Set<string>; // resolved repo files
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
function stemOf(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? b : b.slice(0, i);
}
function extOf(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i < 0 ? "" : b.slice(i).toLowerCase();
}
function joinPosix(...parts: string[]): string {
  return parts.filter((x) => x !== "").join("/");
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function symRegex(sym: string, flags = ""): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(sym)}(?![A-Za-z0-9_])`, flags);
}
function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Dotted module names a python file can be imported as (src/ layout aware). */
function moduleNames(file: string): string[] {
  let noExt = file.replace(/\.pyi?$/, "");
  if (noExt.endsWith("/__init__")) noExt = noExt.slice(0, -"/__init__".length);
  const parts = noExt.split("/").filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) names.push(parts.slice(i).join("."));
  return names;
}

function buildModuleMap(pyFiles: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const sorted = [...pyFiles].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const f of sorted) for (const n of moduleNames(f)) if (!map.has(n)) map.set(n, f);
  return map;
}

function parsePython(file: string, text: string, modules: Map<string, string>, fileSet: Set<string>): PyInfo {
  const defs = new Set<string>();
  for (const m of text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gm)) defs.add(m[1] ?? "");
  for (const m of text.matchAll(/^[ \t]*class[ \t]+([A-Za-z_]\w*)/gm)) defs.add(m[1] ?? "");

  const imports = new Set<string>();
  const addAbs = (name: string): void => {
    const parts = name.split(".");
    for (let n = parts.length; n >= 1; n--) {
      const hit = modules.get(parts.slice(0, n).join("."));
      if (hit) {
        imports.add(hit);
        return;
      }
    }
  };
  const addRel = (baseDir: string, modParts: string[]): void => {
    const dir = joinPosix(baseDir, ...modParts);
    for (const cand of [`${dir}.py`, joinPosix(dir, "__init__.py")]) {
      if (fileSet.has(cand)) {
        imports.add(cand);
        return;
      }
    }
  };

  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[\w.]+$/.test(name)) addAbs(name);
    }
  }
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const dots = m[1] ?? "";
    const mod = m[2] ?? "";
    const names = (m[3] ?? "")
      .replace(/#[^\n]*/g, "")
      .replace(/[()]/g, " ")
      .split(/[,\s]+/)
      .filter((n) => /^\w+$/.test(n) && n !== "as");
    const modParts = mod ? mod.split(".") : [];
    if (dots.length > 0) {
      let base = dirname(file);
      for (let i = 1; i < dots.length; i++) base = dirname(base);
      if (modParts.length > 0) addRel(base, modParts);
      else addRel(base, ["__init__"]);
      for (const n of names) addRel(base, [...modParts, n]);
    } else if (mod) {
      addAbs(mod);
      for (const n of names) {
        const hit = modules.get(`${mod}.${n}`);
        if (hit) imports.add(hit);
      }
    }
  }
  imports.delete(file);
  return { defs, imports };
}

// ---------------------------------------------------------------- scoring

interface Reason {
  text: string;
  w: number;
}
interface Candidate {
  path: string;
  reasons: Reason[];
}

const TEXT_EXT = new Set([".py", ".pyi", ".rst", ".md", ".toml", ".cfg", ".ini", ".txt", ".json", ".yaml", ".yml"]);
const DOC_EXT = new Set([".rst", ".md", ".txt"]);

function isTestFile(p: string): boolean {
  const b = basename(p);
  return /(^|\/)tests?\//.test(p) || /^test_.*\.pyi?$/.test(b) || /_test\.pyi?$/.test(b);
}

function langOf(p: string): string {
  switch (extOf(p)) {
    case ".py":
    case ".pyi":
      return "python";
    case ".rst":
      return "rst";
    case ".md":
      return "markdown";
    case ".toml":
      return "toml";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".ini":
    case ".cfg":
      return "ini";
    default:
      return "text";
  }
}

function scoreOf(c: Candidate | undefined): number {
  return c ? c.reasons.reduce((n, r) => n + r.w, 0) : 0;
}

export async function assembleContext(repo: RepoReader, req: ContextRequest): Promise<ContextBundle> {
  const symbols = extractSymbols(req.task, req.selection?.text);
  const all = (await repo.listFiles()).filter((f) => TEXT_EXT.has(extOf(f)));
  const fileSet = new Set(all);
  if (req.focusFile && !fileSet.has(req.focusFile)) {
    fileSet.add(req.focusFile);
    all.push(req.focusFile);
  }
  all.sort();

  const texts = new Map<string, string>();
  for (const f of all) {
    const t = await repo.read(f);
    if (t !== undefined) texts.set(f, t);
  }
  const files = all.filter((f) => texts.has(f));
  const pyFiles = files.filter((f) => extOf(f) === ".py" || extOf(f) === ".pyi");
  const modules = buildModuleMap(pyFiles);
  const py = new Map<string, PyInfo>();
  for (const f of pyFiles) py.set(f, parsePython(f, texts.get(f) ?? "", modules, fileSet));

  const cands = new Map<string, Candidate>();
  const add = (p: string, text: string, w: number): void => {
    let c = cands.get(p);
    if (!c) cands.set(p, (c = { path: p, reasons: [] }));
    if (!c.reasons.some((r) => r.text === text)) c.reasons.push({ text, w });
  };
  const q = (s: string): string => `\`${s}\``;

  // --- seeds
  const seeds = new Set<string>();
  const definingSyms = new Set<string>();
  if (req.focusFile && texts.has(req.focusFile)) {
    add(req.focusFile, "selected in editor", W.selected);
    seeds.add(req.focusFile);
  }
  for (const f of pyFiles) {
    if (isTestFile(f) && f !== req.focusFile) continue; // test_foo() is not a definition of `foo`
    const defs = py.get(f)?.defs ?? new Set<string>();
    const lowerDefs = new Set([...defs].map((d) => d.toLowerCase()));
    let n = 0;
    for (const s of symbols) {
      if (defs.has(s) || lowerDefs.has(s.toLowerCase())) {
        add(f, `defines ${q(s)}`, n === 0 ? W.defines : W.definesExtra);
        definingSyms.add(s);
        seeds.add(f);
        n++;
      }
    }
  }
  for (const f of files) {
    const segs = f.split("/").map((s) => s.toLowerCase());
    const stem = stemOf(f).toLowerCase();
    for (const s of symbols) {
      const ls = s.toLowerCase();
      if (stem === ls || segs.slice(0, -1).includes(ls)) {
        const strong = extOf(f) === ".py" || DOC_EXT.has(extOf(f));
        add(f, `path matches ${q(ls)}`, strong ? W.pathMatch : W.pathMatchData);
        if (extOf(f) === ".py" && !isTestFile(f)) seeds.add(f);
      }
    }
  }

  // --- expansion from seeds
  const seedList = [...seeds].sort((a, b) => scoreOf(cands.get(b)) - scoreOf(cands.get(a)) || a.localeCompare(b));
  let importerCount = 0;
  let importedByCount = 0;
  for (const s of seedList) {
    const sb = basename(s);
    // seed imports X -> X is "imported by seed"
    for (const x of [...(py.get(s)?.imports ?? [])].sort()) {
      if (importedByCount >= MAX_IMPORT_EXPANSION) break;
      if (isTestFile(x) && !isTestFile(s)) continue;
      add(x, `imported by ${q(sb)}`, W.importedBy);
      importedByCount++;
    }
    if (isTestFile(s)) continue;
    // F imports seed -> F "imports seed" (or "tests seed" if F is a test)
    for (const f of pyFiles) {
      if (f === s || !py.get(f)?.imports.has(s)) continue;
      if (isTestFile(f)) add(f, `tests ${q(sb)}`, W.tests);
      else if (importerCount < MAX_IMPORT_EXPANSION) {
        add(f, `imports ${q(sb)}`, W.imports);
        importerCount++;
      }
    }
    // tests/test_<stem>.py naming convention
    const st = stemOf(s);
    for (const f of files) {
      if (!isTestFile(f)) continue;
      const fst = stemOf(f);
      if (fst === `test_${st}` || fst === `${st}_test`) add(f, `tests ${q(sb)}`, W.tests);
    }
  }

  // docs that mention a symbol some seed defines
  let docCount = 0;
  for (const f of files) {
    if (!DOC_EXT.has(extOf(f)) || docCount >= MAX_DOCS) continue;
    const t = texts.get(f) ?? "";
    for (const s of [...definingSyms].sort()) {
      if (t.includes(s) && symRegex(s).test(t)) {
        add(f, `documents ${q(s)}`, W.documents);
        docCount++;
        break;
      }
    }
  }

  // weak signal: mentions (capped)
  const mentionList: { f: string; s: string; w: number }[] = [];
  for (const f of files) {
    if (cands.get(f)?.reasons.some((r) => r.text.startsWith("defines ") || r.text.startsWith("documents "))) continue;
    const t = texts.get(f) ?? "";
    for (const s of symbols) {
      if (definingSyms.has(s) && DOC_EXT.has(extOf(f))) continue;
      if (!t.includes(s)) continue;
      const count = (t.match(symRegex(s, "g")) ?? []).length;
      if (count > 0) {
        mentionList.push({ f, s, w: W.mentions + Math.min(count, 5) * 0.2 });
        break;
      }
    }
  }
  mentionList.sort((a, b) => b.w - a.w || a.f.localeCompare(b.f));
  for (const m of mentionList.slice(0, MAX_MENTIONS)) add(m.f, `mentions ${q(m.s)}`, m.w);

  // --- rank
  const ranked = [...cands.values()]
    .map((c) => {
      const rs = [...c.reasons].sort((a, b) => b.w - a.w || a.text.localeCompare(b.text));
      return {
        path: c.path,
        reasons: rs.map((r) => r.text),
        score: Math.round(rs.reduce((n, r) => n + r.w, 0) * 100) / 100,
      };
    })
    .filter((c) => texts.has(c.path))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // --- budget
  const items: ContextItem[] = [];
  const dropped: ContextBundle["dropped"] = [];
  let used = 0;
  for (const r of ranked) {
    const full = texts.get(r.path) ?? "";
    const fullTokens = tokensOf(full);
    const remaining = req.budgetTokens - used;
    // No single file may hog more than 35% of the budget; big files become excerpts.
    if (fullTokens <= remaining && fullTokens <= Math.max(1, Math.floor(req.budgetTokens * MAX_FILE_SHARE))) {
      items.push({ ...r, tokens: fullTokens, content: full });
      used += fullTokens;
      continue;
    }
    const ex = excerptFor(r.path, full, symbols, req, remaining);
    if (ex) {
      items.push({ ...r, tokens: ex.tokens, content: ex.content, excerpt: ex.range });
      used += ex.tokens;
    } else if (dropped.length < MAX_DROPPED) {
      dropped.push({ path: r.path, reasons: r.reasons, tokens: fullTokens });
    }
  }
  return { items, dropped, totalTokens: used, budgetTokens: req.budgetTokens, symbols };
}

// ---------------------------------------------------------------- excerpts

function excerptFor(
  file: string,
  text: string,
  symbols: string[],
  req: ContextRequest,
  remainingTokens: number,
): { content: string; tokens: number; range: { startLine: number; endLine: number } } | undefined {
  if (remainingTokens <= 0) return undefined;
  const lines = text.split("\n");
  const hits: number[] = [];
  if (file === req.focusFile && req.selection) hits.push(Math.max(1, Math.min(req.selection.startLine, lines.length)));
  for (const s of symbols) {
    const def = new RegExp(`^[ \\t]*(?:async[ \\t]+)?(?:def|class)[ \\t]+${escapeRe(s)}(?![A-Za-z0-9_])`, "i");
    const i = lines.findIndex((l) => def.test(l));
    if (i >= 0) hits.push(i + 1);
  }
  if (hits.length === 0) {
    for (const s of symbols) {
      const re = symRegex(s);
      const i = lines.findIndex((l) => re.test(l));
      if (i >= 0) hits.push(i + 1);
    }
  }
  if (hits.length === 0) hits.push(1);
  const firstHit = hits[0] ?? 1;

  // Merge overlapping windows; keep the merged window that holds the first hit.
  const windowAt = (radius: number): { startLine: number; endLine: number } => {
    const wins = [...new Set(hits)]
      .sort((a, b) => a - b)
      .map((h) => ({ s: Math.max(1, h - radius), e: Math.min(lines.length, h + radius) }));
    const merged: { s: number; e: number }[] = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && w.s <= last.e + 1) last.e = Math.max(last.e, w.e);
      else merged.push({ ...w });
    }
    const pick = merged.find((m) => firstHit >= m.s && firstHit <= m.e) ?? merged[0] ?? { s: 1, e: lines.length };
    return { startLine: pick.s, endLine: pick.e };
  };

  for (const radius of [EXCERPT_RADIUS, 15, 8, 3, 0]) {
    const range = windowAt(radius);
    const content = lines.slice(range.startLine - 1, range.endLine).join("\n");
    const tokens = tokensOf(content);
    if (tokens <= remainingTokens) return { content, tokens, range };
  }
  return undefined;
}

// ---------------------------------------------------------------- rendering

export function renderContext(bundle: ContextBundle): string {
  const parts: string[] = [];
  for (const it of bundle.items) {
    const why = it.reasons.join("; ");
    const range = it.excerpt ? ` [lines ${it.excerpt.startLine}-${it.excerpt.endLine}]` : "";
    let fence = "```";
    while (it.content.includes(fence)) fence += "`";
    parts.push(`### ${it.path} (why: ${why})${range}\n${fence}${langOf(it.path)}\n${it.content}\n${fence}`);
  }
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

// ---------------------------------------------------------------- disk reader

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  "build",
  "dist",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);
const MAX_FILES = 4000;
const MAX_BYTES = 200 * 1024;

export function nodeRepoReader(root: string): RepoReader {
  let cache: Promise<string[]> | undefined;
  const walk = async (): Promise<string[]> => {
    const out: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      if (out.length >= MAX_FILES) return;
      let entries;
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info")) continue;
          await visit(r);
        } else if (e.isFile() && TEXT_EXT.has(extOf(e.name))) {
          try {
            if ((await fs.stat(path.join(root, r))).size > MAX_BYTES) continue;
          } catch {
            continue;
          }
          out.push(r);
        }
      }
    };
    await visit("");
    return out;
  };
  return {
    listFiles: () => (cache ??= walk()),
    async read(p: string): Promise<string | undefined> {
      const abs = path.resolve(root, p);
      if (!abs.startsWith(path.resolve(root))) return undefined;
      try {
        return await fs.readFile(abs, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
