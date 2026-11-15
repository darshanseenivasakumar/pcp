from __future__ import annotations

import json
from pathlib import Path

import pytest

from pcp_verifier.contracts import CONTRACTS_DIR, REPO_ROOT

EXAMPLES = CONTRACTS_DIR / "examples"
TINY_REPO = REPO_ROOT / "fixtures" / "tiny_repo"


def load_example(name: str):
    return json.loads((EXAMPLES / name).read_text(encoding="utf-8"))


def tiny_diff(name: str) -> str:
    return (TINY_REPO / "diffs" / f"{name}.diff").read_text(encoding="utf-8")


@pytest.fixture
def tiny_repo(tmp_path: Path) -> Path:
    """A throwaway copy of fixtures/tiny_repo, so tests never touch the shared fixture."""
    import shutil

    dst = tmp_path / "tiny_repo"
    shutil.copytree(TINY_REPO, dst, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    return dst
