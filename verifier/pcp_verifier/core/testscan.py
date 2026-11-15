"""Static (AST) view of test functions: ids, assert strength, skip markers.

Used to find F2P tests (new/changed in the diff) and to detect tampering with
protected tests (deleted, skipped, or asserts weakened) without trusting any
model's description of the change.
"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from xml.etree import ElementTree

from pcp_verifier.contracts import RunResult, TamperEvent

SKIP_MARKS = {"skip", "skipif", "xfail"}
ASSERT_CONTEXTS = {"raises", "warns", "deprecated_call", "assertRaises", "assertWarns"}
_PARAMS = re.compile(r"\[.*\]$")


@dataclass(frozen=True)
class TestFingerprint:
    test_id: str  # "tests/test_x.py::TestCls::test_y" (no parametrize suffix)
    asserts: int
    skipped: bool
    body_hash: str

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> TestFingerprint:
        return cls(**d)


def function_id(node_id: str) -> str:
    """Strip the parametrize suffix: `f.py::test_a[1-2]` -> `f.py::test_a`."""
    return _PARAMS.sub("", node_id)


def _names(expr: ast.AST) -> set[str]:
    out = set()
    for n in ast.walk(expr):
        if isinstance(n, ast.Name):
            out.add(n.id)
        elif isinstance(n, ast.Attribute):
            out.add(n.attr)
    return out


def _is_skip_decorator(dec: ast.expr) -> bool:
    return bool(_names(dec) & SKIP_MARKS)


def _calls_skip(fn: ast.AST) -> bool:
    for n in ast.walk(fn):
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr in {"skip", "xfail"}
            and isinstance(n.func.value, ast.Name)
            and n.func.value.id == "pytest"
        ):
            return True
    return False


def _count_asserts(fn: ast.AST) -> int:
    """Asserts that can actually fail. `assert True` / `assert 1` do not count."""
    count = 0
    for n in ast.walk(fn):
        if isinstance(n, ast.Assert):
            if isinstance(n.test, ast.Constant) and n.test.value:
                continue
            count += 1
        elif isinstance(n, ast.With | ast.AsyncWith):
            for item in n.items:
                if isinstance(item.context_expr, ast.Call) and (
                    _names(item.context_expr.func) & ASSERT_CONTEXTS
                ):
                    count += 1
        elif (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr.startswith("assert")
        ):
            count += 1  # self.assertEqual(...), mock.assert_called_once_with(...)
    return count


def _body_hash(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    dump = "\n".join(ast.dump(stmt) for stmt in fn.body)
    return hashlib.sha1(dump.encode()).hexdigest()[:16]


def _module_skipped(tree: ast.Module) -> bool:
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "pytestmark" for t in stmt.targets
        ):
            return bool(_names(stmt.value) & SKIP_MARKS)
    return False


def scan_source(source: str, rel_path: str) -> dict[str, TestFingerprint]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}
    rel = rel_path.replace("\\", "/")
    mod_skip = _module_skipped(tree)
    out: dict[str, TestFingerprint] = {}

    def add(fn, prefix: str, inherited_skip: bool):
        tid = f"{rel}::{prefix}{fn.name}"
        skipped = (
            inherited_skip
            or any(_is_skip_decorator(d) for d in fn.decorator_list)
            or _calls_skip(fn)
        )
        out[tid] = TestFingerprint(tid, _count_asserts(fn), skipped, _body_hash(fn))

    for stmt in tree.body:
        if isinstance(stmt, ast.FunctionDef | ast.AsyncFunctionDef) and stmt.name.startswith(
            "test"
        ):
            add(stmt, "", mod_skip)
        elif isinstance(stmt, ast.ClassDef) and stmt.name.startswith("Test"):
            cls_skip = mod_skip or any(_is_skip_decorator(d) for d in stmt.decorator_list)
            for sub in stmt.body:
                if isinstance(sub, ast.FunctionDef | ast.AsyncFunctionDef) and sub.name.startswith(
                    "test"
                ):
                    add(sub, f"{stmt.name}::", cls_skip)
    return out


def scan_file(root: Path, rel_path: str) -> dict[str, TestFingerprint]:
    path = Path(root) / rel_path
    if not path.is_file():
        return {}
    return scan_source(path.read_text(encoding="utf-8", errors="replace"), rel_path)


def scan_files(root: Path, rel_paths: list[str]) -> dict[str, TestFingerprint]:
    out: dict[str, TestFingerprint] = {}
    for rel in rel_paths:
        out.update(scan_file(root, rel))
    return out


def new_or_changed(
    before: dict[str, TestFingerprint], after: dict[str, TestFingerprint]
) -> list[str]:
    """Test functions added by the patch, or whose body the patch changed."""
    return sorted(
        tid
        for tid, fp in after.items()
        if tid not in before or before[tid].body_hash != fp.body_hash
    )


def detect_tampering(
    protected: dict[str, TestFingerprint],
    patched: dict[str, TestFingerprint],
    patched_run: RunResult | None = None,
) -> list[TamperEvent]:
    """Compare protected tests (pre-existing + frozen F2P) with the patched tree."""
    events: list[TamperEvent] = []
    runtime_skips = {
        function_id(t)
        for t, o in (patched_run.tests if patched_run else {}).items()
        if o == "skipped"
    }
    for tid, fp in sorted(protected.items()):
        new = patched.get(tid)
        if new is None:
            twin = next(
                (
                    p
                    for p in patched.values()
                    if p.body_hash == fp.body_hash and p.test_id not in protected
                ),
                None,
            )
            if twin:
                events.append(
                    TamperEvent(test_id=tid, kind="renamed", detail=f"renamed to {twin.test_id}")
                )
            else:
                events.append(
                    TamperEvent(test_id=tid, kind="deleted", detail="protected test was removed")
                )
        elif new.skipped and not fp.skipped:
            events.append(
                TamperEvent(test_id=tid, kind="skipped", detail="skip/xfail marker added")
            )
        elif tid in runtime_skips and not fp.skipped:
            events.append(
                TamperEvent(test_id=tid, kind="skipped", detail="test is skipped at run time")
            )
        elif new.asserts < fp.asserts:
            events.append(
                TamperEvent(
                    test_id=tid,
                    kind="weakened_assert",
                    detail=f"asserts went from {fp.asserts} to {new.asserts}",
                )
            )
    return events


# ------------------------------------------------------------------ junit
def parse_junit(xml_path: Path) -> dict[str, str]:
    """node id -> passed|failed|skipped|error, from pytest's xunit1 junit XML."""
    if not Path(xml_path).is_file():
        return {}
    try:
        root = ElementTree.parse(xml_path).getroot()
    except ElementTree.ParseError:
        return {}
    out: dict[str, str] = {}
    for case in root.iter("testcase"):
        name = case.get("name", "")
        file = (case.get("file") or "").replace("\\", "/")
        classname = case.get("classname", "")
        if file:
            module = file.removesuffix(".py").replace("/", ".")
            cls = classname[len(module) :].lstrip(".") if classname.startswith(module) else ""
            node_id = f"{file}::{cls + '::' if cls else ''}{name}"
        else:
            node_id = f"<collection>::{classname or name}"
        if case.find("failure") is not None:
            outcome = "failed"
        elif case.find("error") is not None:
            outcome = "error"
        elif case.find("skipped") is not None:
            outcome = "skipped"
        else:
            outcome = "passed"
        out[node_id] = outcome
    return out
