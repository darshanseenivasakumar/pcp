from __future__ import annotations

import pytest
from conftest import TINY_REPO, tiny_diff

from pcp_verifier.core.diffparse import (
    DiffError,
    is_test_path,
    only_files,
    parse_diff,
    rewrite_fraction,
)


@pytest.mark.parametrize(
    "path, expected",
    [
        ("tests/test_x.py", True),
        ("src/pkg/test_util.py", True),
        ("pkg/util_test.py", True),
        ("tests/conftest.py", True),
        ("tests/data/fixture.json", True),
        ("src/flask/helpers.py", False),
        ("src/flask/testing.py", False),
        ("docs/config.rst", False),
    ],
)
def test_is_test_path(path, expected):
    assert is_test_path(path) is expected


def test_parse_good_diff():
    p = parse_diff(tiny_diff("good"))
    assert p.changed_files == ["src/tiny/mathx.py", "tests/test_mathx.py"]
    assert [f.path for f in p.test_files] == ["tests/test_mathx.py"]
    assert [h.hunk_id for h in p.hunks] == ["h1", "h2"]
    src = p.file("src/tiny/mathx.py")
    assert src.added[0][1] == 'TRUE_VALUES = {"1", "true", "yes", "on"}'
    assert src.removed[0][1] == 'TRUE_VALUES = {"1", "true", "yes"}'


def test_only_test_files_roundtrip():
    p = parse_diff(tiny_diff("good"))
    tests_only = parse_diff(only_files(p, p.test_files))
    assert tests_only.changed_files == ["tests/test_mathx.py"]


def test_rewrite_fraction_small_change():
    p = parse_diff(tiny_diff("good"))
    assert rewrite_fraction(p.file("src/tiny/mathx.py"), TINY_REPO) < 0.1


@pytest.mark.parametrize("bad", ["", "   ", "not a diff at all"])
def test_bad_diff_fails_loudly(bad):
    with pytest.raises(DiffError):
        parse_diff(bad)
