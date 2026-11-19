"""Parse a unified diff into hunks, changed lines and test/source splits."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from unidiff import PatchSet
from unidiff.errors import UnidiffParseError

from pcp_verifier.contracts import Hunk


class DiffError(ValueError):
    """The diff could not be parsed (raised loudly; never silently ignored)."""


@dataclass
class FileChange:
    path: str
    is_test: bool
    is_added: bool
    is_removed: bool
    added: list[tuple[int, str]] = field(default_factory=list)  # (new line no, text)
    removed: list[tuple[int, str]] = field(default_factory=list)  # (old line no, text)
    hunks: list[Hunk] = field(default_factory=list)
    patch_text: str = ""

    @property
    def changed_line_count(self) -> int:
        # a modified line shows up as one removal + one addition; count it once
        return max(len(self.added), len(self.removed))


@dataclass
class ParsedDiff:
    files: list[FileChange]

    @property
    def hunks(self) -> list[Hunk]:
        return [h for f in self.files for h in f.hunks]

    @property
    def changed_files(self) -> list[str]:
        return [f.path for f in self.files]

    @property
    def test_files(self) -> list[FileChange]:
        return [f for f in self.files if f.is_test]

    @property
    def source_files(self) -> list[FileChange]:
        return [f for f in self.files if not f.is_test]

    def file(self, path: str) -> FileChange | None:
        return next((f for f in self.files if f.path == path), None)


_TEST_NAME = re.compile(r"^(test_.*|.*_test)\.py$|^conftest\.py$")


def is_test_path(path: str) -> bool:
    p = PurePosixPath(path.replace("\\", "/"))
    if _TEST_NAME.match(p.name):
        return True
    return any(part in {"tests", "test", "testing"} for part in p.parts[:-1])


def _clean(path: str) -> str:
    return path[2:] if path.startswith(("a/", "b/")) else path


def parse_diff(diff: str) -> ParsedDiff:
    if not diff.strip():
        raise DiffError("empty diff")
    try:
        patch = PatchSet.from_string(diff)
    except UnidiffParseError as e:
        raise DiffError(f"unparseable diff: {e}") from e
    if len(patch) == 0:
        raise DiffError("diff contains no file changes")

    files: list[FileChange] = []
    n = 0
    for pf in patch:
        path = _clean(pf.path)
        fc = FileChange(
            path=path,
            is_test=is_test_path(path),
            is_added=pf.is_added_file,
            is_removed=pf.is_removed_file,
            patch_text=str(pf),
        )
        for h in pf:
            n += 1
            fc.hunks.append(
                Hunk(
                    hunk_id=f"h{n}",
                    file=path,
                    old_start=h.source_start,
                    old_lines=h.source_length,
                    new_start=h.target_start,
                    new_lines=h.target_length,
                )
            )
            for line in h:
                text = line.value.rstrip("\r\n")
                if line.is_added:
                    fc.added.append((line.target_line_no, text))
                elif line.is_removed:
                    fc.removed.append((line.source_line_no, text))
        files.append(fc)
    return ParsedDiff(files=files)


def only_files(parsed: ParsedDiff, keep: list[FileChange]) -> str:
    """Rebuild a diff containing only the given files (e.g. just the test files)."""
    keep_paths = {f.path for f in keep}
    return "".join(f.patch_text for f in parsed.files if f.path in keep_paths)


def rewrite_fraction(fc: FileChange, repo_root: str | Path) -> float:
    """Fraction of the original file's lines this patch changes (0..1).

    New files count as 0 (nothing was rewritten); deleted files count as 1.
    """
    if fc.is_added:
        return 0.0
    if fc.is_removed:
        return 1.0
    original = Path(repo_root) / fc.path
    try:
        total = len(original.read_text(encoding="utf-8", errors="replace").splitlines())
    except OSError:
        return 0.0
    if total == 0:
        return 0.0
    return min(1.0, fc.changed_line_count / total)
