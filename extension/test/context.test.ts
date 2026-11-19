import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assembleContext, extractSymbols, nodeRepoReader, renderContext } from "../src/context/assemble";
import type { RepoReader } from "../src/context/assemble";

function memRepo(files: Record<string, string>): RepoReader {
  return {
    listFiles: async () => Object.keys(files).sort(),
    read: async (p) => files[p],
  };
}

const helpers = [
  '"""Helpers."""',
  "import os",
  "",
  "def get_debug_flag() -> bool:",
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  "",
].join("\n");

const flask = memRepo({
  "src/flask/__init__.py": "from .app import Flask\n",
  "src/flask/helpers.py": helpers,
  "src/flask/cli.py": [
    "import click",
    "from .helpers import get_debug_flag",
    "",
    "@click.group()",
    "def cli():",
    "    pass",
    "",
  ].join("\n"),
  "src/flask/config.py": "class Config(dict):\n    pass\n",
  "src/flask/sessions.py": "class SecureCookieSession(dict):\n    pass\n",
  "tests/test_helpers.py": "from flask.helpers import get_debug_flag\n\ndef test_flag():\n    assert not get_debug_flag()\n",
  "tests/test_cli.py": "from flask.cli import cli\n\ndef test_cli():\n    assert cli\n",
  "docs/cli.rst": "Command Line\n============\n\nThe cli group.\n",
  "docs/config.rst": "Configuration\n=============\n",
});

describe("extractSymbols", () => {
  it("finds backticked, snake_case, CamelCase and env-var symbols", () => {
    expect(extractSymbols("Make `get_debug_flag` honour FLASK_DEBUG for SessionInterface")).toEqual([
      "get_debug_flag",
      "FLASK_DEBUG",
      "SessionInterface",
    ]);
  });
  it("drops the command prefix of backticked CLI commands", () => {
    expect(extractSymbols("Add a `flask config` command")).toEqual(["config"]);
  });
  it("ignores quoted values and stopwords", () => {
    expect(extractSymbols('Also treat "off" and "n" as false in the test docs')).toEqual([]);
  });
});

describe("assembleContext on tiny_repo", () => {
  it("ranks the defining file first and includes its test", async () => {
    const root = join(__dirname, "..", "..", "fixtures", "tiny_repo");
    const b = await assembleContext(nodeRepoReader(root), {
      task: 'Make parse_bool also treat "on" as true.',
      budgetTokens: 8000,
    });
    expect(b.items[0]?.path).toBe("src/tiny/mathx.py");
    expect(b.items[0]?.reasons).toContain("defines `parse_bool`");
    const t = b.items.find((i) => i.path === "tests/test_mathx.py");
    expect(t).toBeDefined();
    expect(t?.reasons.some((r) => r === "tests `mathx.py`" || r === "imports `mathx.py`")).toBe(true);
  });
});

describe("assembleContext on mini flask", () => {
  it("Task A: helpers, its test, then its importer; not sessions", async () => {
    const b = await assembleContext(flask, {
      task: 'Make get_debug_flag also treat "off" and "n" as false.',
      budgetTokens: 8000,
    });
    const paths = b.items.map((i) => i.path);
    expect(paths.slice(0, 3)).toEqual(["src/flask/helpers.py", "tests/test_helpers.py", "src/flask/cli.py"]);
    expect(b.items[0]?.reasons).toContain("defines `get_debug_flag`");
    expect(b.items[1]?.reasons).toContain("tests `helpers.py`");
    expect(b.items[2]?.reasons).toContain("imports `helpers.py`");
    expect(paths).not.toContain("src/flask/sessions.py");
  });

  it("Task B: cli, config, test_cli and docs", async () => {
    const b = await assembleContext(flask, {
      task: "Add a `flask config` CLI command that shows the app's configuration and masks secret values, with a test and docs.",
      budgetTokens: 8000,
    });
    const by = new Map(b.items.map((i) => [i.path, i]));
    expect(by.get("src/flask/cli.py")?.reasons).toContain("path matches `cli`");
    expect(by.has("src/flask/config.py")).toBe(true);
    expect(by.get("tests/test_cli.py")?.reasons).toContain("tests `cli.py`");
    expect(by.has("docs/cli.rst")).toBe(true);
    expect(by.has("src/flask/sessions.py")).toBe(false);
  });

  it("focus file and selection come first as 'selected in editor'", async () => {
    const b = await assembleContext(flask, {
      task: "Handle empty values",
      focusFile: "src/flask/config.py",
      selection: { startLine: 1, endLine: 2, text: "class Config(dict):" },
      budgetTokens: 8000,
    });
    expect(b.items[0]?.path).toBe("src/flask/config.py");
    expect(b.items[0]?.reasons[0]).toBe("selected in editor");
  });
});

describe("budget", () => {
  const big = Array.from({ length: 200 }, (_, i) => `x${i} = ${i}`).join("\n");
  const long = memRepo({
    "src/pkg/__init__.py": "",
    "src/pkg/mod.py": `${big}\n\ndef target_fn():\n    return 1\n\n${big}\n`,
    "tests/test_mod.py": `${big}\nfrom pkg.mod import target_fn\n`,
  });

  it("falls back to excerpts with 1-based ranges and fills dropped", async () => {
    const b = await assembleContext(long, { task: "Change `target_fn`", budgetTokens: 300 });
    expect(b.totalTokens).toBeLessThanOrEqual(300);
    const m = b.items.find((i) => i.path === "src/pkg/mod.py");
    expect(m?.excerpt).toBeDefined();
    const ex = m?.excerpt;
    if (!ex) throw new Error("no excerpt");
    expect(ex.startLine).toBeGreaterThanOrEqual(1);
    // def target_fn is on line 202
    expect(ex.startLine).toBeLessThanOrEqual(202);
    expect(ex.endLine).toBeGreaterThanOrEqual(202);
    expect(m?.content.split("\n")).toHaveLength(ex.endLine - ex.startLine + 1);
    expect(m?.content).toContain("def target_fn");
    expect(b.dropped.length + b.items.length).toBeGreaterThanOrEqual(2);
  });

  it("drops what cannot fit even as an excerpt", async () => {
    const b = await assembleContext(long, { task: "Change `target_fn`", budgetTokens: 5 });
    expect(b.totalTokens).toBeLessThanOrEqual(5);
    expect(b.dropped.length).toBeGreaterThan(0);
  });
});

describe("renderContext", () => {
  it("contains each path and its reasons", async () => {
    const b = await assembleContext(flask, { task: "Make `get_debug_flag` stricter", budgetTokens: 8000 });
    const text = renderContext(b);
    for (const it of b.items) {
      expect(text).toContain(`### ${it.path} (why: ${it.reasons.join("; ")})`);
    }
    expect(text).toContain("```python");
  });
  it("labels excerpts with their line range", async () => {
    const big = Array.from({ length: 300 }, (_, i) => `v${i} = 1`).join("\n");
    const b = await assembleContext(memRepo({ "a.py": `${big}\ndef hit_me():\n    pass\n` }), {
      task: "Fix `hit_me`",
      budgetTokens: 200,
    });
    expect(renderContext(b)).toMatch(/\[lines \d+-\d+\]/);
  });
});
