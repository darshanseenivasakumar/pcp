"""Scope checker: does the patch stay inside the task?

* protected paths (.git, .env, keys)             -> critical
* lockfile / CI / packaging config edits         -> warning (unless the task asks)
* files unrelated to the task                    -> warning
* a file rewritten by more than 50%              -> big_rewrite (a human decides)
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath

from pcp_verifier.checkers.common import ResultBuilder, parsed, tokens
from pcp_verifier.contracts import CheckResult, PatchContext
from pcp_verifier.core.diffparse import FileChange, rewrite_fraction

NAME = "scope"

M_PROTECTED = 90
M_CONFIG = 40
M_UNRELATED = 30
M_UNRELATED_EACH = 10
M_UNRELATED_MAX = 70
M_BIG_REWRITE = 50
M_DELETED = 40
M_TOO_MANY_FILES = 40
BIG_REWRITE_FRACTION = 0.5
BIG_REWRITE_MIN_LINES = 10
MAX_FILES = 15

PROTECTED = re.compile(r"(^|/)(\.git/|\.env($|\.)|id_rsa|id_ed25519|.*\.pem$|.*\.key$|\.ssh/)")
CONFIG = {
    "lockfile": re.compile(r"(^|/)(poetry\.lock|uv\.lock|Pipfile\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt)$"),
    "ci": re.compile(r"(^|/)(\.github/workflows/|\.gitlab-ci\.yml$|\.circleci/|azure-pipelines\.yml$|Jenkinsfile$)"),
    "config": re.compile(r"(^|/)(pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|\.pre-commit-config\.yaml|noxfile\.py|MANIFEST\.in)$"),
}  # fmt: skip
CONFIG_WORDS = {
    "lockfile": {
        "dependency",
        "dependencies",
        "lock",
        "lockfile",
        "requirements",
        "upgrade",
        "pin",
    },
    "ci": {"ci", "workflow", "workflows", "pipeline", "github", "actions"},
    # packaging config only: "config"/"configuration" usually means the *app's* config
    "config": {"pyproject", "packaging", "setup", "tox", "build", "dependency", "dependencies"},
}
DOC_RE = re.compile(r"(^|/)(docs?/|CHANGES|CHANGELOG|HISTORY|README)|\.(rst|md)$", re.I)
DOC_WORDS = {"doc", "docs", "documentation", "documented", "document", "changelog", "readme"}
DELETE_WORDS = {"delete", "remove", "drop", "deprecate", "deprecated", "cleanup"}


def _file_tokens(fc: FileChange) -> set[str]:
    p = PurePosixPath(fc.path)
    return tokens(" ".join([*p.parts[:-1], p.stem]))


def _defined_names(fc: FileChange) -> set[str]:
    """Names a file's added lines define (def/class/assignment/CLI command names)."""
    out = set()
    for _, t in fc.added:
        for m in re.finditer(
            r"\b(?:def|class)\s+([A-Za-z_]\w*)|^\s*([A-Za-z_]\w*)\s*=|command\(\s*[\"']([\w-]+)", t
        ):
            out |= {g.lower() for g in m.groups() if g}
    return out


def _defines_task_symbol(fc: FileChange, symbols: set[str], roots: list[Path]) -> bool:
    """Does the file (before or after the patch) define a function/class the task names?"""
    if not symbols or not fc.path.endswith(".py"):
        return False
    pattern = re.compile(
        r"^\s*(?:async\s+)?(?:def|class)\s+(" + "|".join(map(re.escape, symbols)) + r")\b", re.M
    )
    for root in roots:
        path = root / fc.path
        try:
            if path.is_file() and pattern.search(
                path.read_text(encoding="utf-8", errors="replace")
            ):
                return True
        except OSError:
            continue
    return False


def _module_names(path: str) -> set[str]:
    p = PurePosixPath(path)
    if p.suffix != ".py":
        return set()
    parts = list(p.with_suffix("").parts)
    if parts and parts[0] == "src":
        parts = parts[1:]
    return {".".join(parts), p.stem} if parts else set()


def relevant_files(task: str, files: list[FileChange], roots: list[Path] | None = None) -> set[str]:
    """Heuristic relevance: task tokens in the path or hunk text, or the file
    defines a symbol the task names; then spread to files that use names the
    relevant files define or import them, tests of relevant sources, and docs
    when the task mentions documentation."""
    task_toks = tokens(task)
    symbols = {
        w for w in re.findall(r"[A-Za-z_]\w*", task) if "_" in w or any(c.isupper() for c in w[1:])
    }
    relevant: set[str] = set()
    for fc in files:
        if task_toks & (_file_tokens(fc) | tokens(fc.patch_text)) or _defines_task_symbol(
            fc, symbols, roots or []
        ):
            relevant.add(fc.path)
    # a relevant file that imports this module makes it relevant too (e.g. test -> source)
    relevant_text = " ".join(f.patch_text for f in files if f.path in relevant)
    for fc in files:
        mods = _module_names(fc.path)
        if fc.path not in relevant and any(
            re.search(rf"\b{re.escape(m)}\b", relevant_text) for m in mods if "." in m
        ):
            relevant.add(fc.path)
    # spread one hop through names the relevant files define (e.g. new CLI command used in docs/tests)
    defined = (
        set().union(*(_defined_names(f) for f in files if f.path in relevant))
        if relevant
        else set()
    )
    for fc in files:
        if fc.path in relevant:
            continue
        added_toks = tokens(" ".join(t for _, t in fc.added))
        if (
            defined & added_toks
            or fc.is_test
            and any(f.path in relevant and not f.is_test for f in files)
            or DOC_RE.search(fc.path)
            and task_toks & DOC_WORDS
        ):
            relevant.add(fc.path)
    return relevant


async def run(ctx: PatchContext) -> CheckResult:
    r = ResultBuilder(NAME)
    files = parsed(ctx).files
    task_toks = tokens(ctx.task) | {w.lower() for w in re.findall(r"\w+", ctx.task)}

    for fc in files:
        if PROTECTED.search(fc.path):
            r.add(
                M_PROTECTED,
                critical=True,
                type="out_of_scope",
                source="heuristic",
                confidence=1.0,
                file=fc.path,
                message=f"Patch touches a protected path: {fc.path}",
                action="Never modify .git, .env or key files",
            )
            continue
        for kind, rx in CONFIG.items():
            if rx.search(fc.path) and not (task_toks & CONFIG_WORDS[kind]):
                r.add(
                    M_CONFIG,
                    type="out_of_scope",
                    source="heuristic",
                    confidence=0.7,
                    file=fc.path,
                    message=f"Patch edits a {kind} file ({fc.path}) the task did not ask for",
                    action=f"Revert the {kind} change unless it is required",
                )
        if fc.is_removed and not (task_toks & DELETE_WORDS):
            r.add(
                M_DELETED,
                type="out_of_scope",
                source="heuristic",
                confidence=0.7,
                file=fc.path,
                message=f"Patch deletes {fc.path}, which the task did not ask for",
                action="Keep the file",
            )
        frac = rewrite_fraction(fc, ctx.repo_root)
        if (
            not fc.is_added
            and frac > BIG_REWRITE_FRACTION
            and fc.changed_line_count >= BIG_REWRITE_MIN_LINES
        ):
            r.add(
                M_BIG_REWRITE,
                type="big_rewrite",
                source="heuristic",
                confidence=1.0,
                file=fc.path,
                message=f"Patch rewrites {frac:.0%} of {fc.path}; a human must approve",
                action="Make a smaller, targeted change, or get a human to approve the rewrite",
            )

    relevant = relevant_files(ctx.task, files, [Path(ctx.repo_root), Path(ctx.shadow_root)])
    unrelated = [fc for fc in files if fc.path not in relevant and not PROTECTED.search(fc.path)]
    for i, fc in enumerate(unrelated):
        r.add(
            0,
            type="out_of_scope",
            source="heuristic",
            confidence=0.6,
            file=fc.path,
            line_start=(fc.added or fc.removed or [(None, "")])[0][0],
            line_end=(fc.added or fc.removed or [(None, "")])[0][0],
            message=f"{fc.path} looks unrelated to the task",
            action="Drop changes unrelated to the task",
        )
        r.bump(min(M_UNRELATED_MAX, M_UNRELATED + M_UNRELATED_EACH * i))
    if len(files) > MAX_FILES:
        r.add(
            M_TOO_MANY_FILES,
            type="out_of_scope",
            source="heuristic",
            confidence=0.6,
            message=f"Patch touches {len(files)} files (> {MAX_FILES})",
            action="Split the change",
        )
    return r.build()
