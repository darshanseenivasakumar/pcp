from __future__ import annotations

from pcp_verifier.core.testscan import detect_tampering, function_id, new_or_changed, scan_source

BASE = """
import pytest

def test_a():
    assert 1 == 1
    assert 2 == 2

class TestB:
    def test_c(self):
        with pytest.raises(ValueError):
            int("x")

def helper():
    assert False
"""


def fps(src):
    return scan_source(src, "tests/test_x.py")


def test_scan_ids_and_asserts():
    s = fps(BASE)
    assert set(s) == {"tests/test_x.py::test_a", "tests/test_x.py::TestB::test_c"}
    assert s["tests/test_x.py::test_a"].asserts == 2
    assert s["tests/test_x.py::TestB::test_c"].asserts == 1


def test_assert_true_does_not_count():
    s = fps("def test_a():\n    assert True\n    assert 1\n")
    assert s["tests/test_x.py::test_a"].asserts == 0


def test_function_id_strips_params():
    assert function_id("t.py::test_a[1-x]") == "t.py::test_a"
    assert function_id("t.py::C::test_a") == "t.py::C::test_a"


def test_no_tampering_when_unchanged():
    assert detect_tampering(fps(BASE), fps(BASE)) == []


def test_detect_deleted():
    after = BASE.replace("def test_a():\n    assert 1 == 1\n    assert 2 == 2\n", "")
    ev = detect_tampering(fps(BASE), fps(after))
    assert [(e.test_id, e.kind) for e in ev] == [("tests/test_x.py::test_a", "deleted")]


def test_detect_skip_decorator():
    after = BASE.replace("def test_a", "@pytest.mark.skip\ndef test_a")
    assert detect_tampering(fps(BASE), fps(after))[0].kind == "skipped"


def test_detect_skip_call_and_module_skip():
    after = BASE.replace("    assert 1 == 1\n", "    pytest.skip('later')\n    assert 1 == 1\n")
    assert detect_tampering(fps(BASE), fps(after))[0].kind == "skipped"
    mod = BASE.replace("import pytest\n", "import pytest\npytestmark = pytest.mark.skip\n")
    assert {e.kind for e in detect_tampering(fps(BASE), fps(mod))} == {"skipped"}


def test_detect_xfail_on_class():
    after = BASE.replace("class TestB:", "@pytest.mark.xfail\nclass TestB:")
    ev = detect_tampering(fps(BASE), fps(after))
    assert [(e.test_id, e.kind) for e in ev] == [("tests/test_x.py::TestB::test_c", "skipped")]


def test_detect_weakened_assert():
    after = BASE.replace("    assert 2 == 2\n", "")
    assert detect_tampering(fps(BASE), fps(after))[0].kind == "weakened_assert"
    trivial = BASE.replace("assert 1 == 1", "assert True").replace("assert 2 == 2", "assert True")
    assert detect_tampering(fps(BASE), fps(trivial))[0].kind == "weakened_assert"


def test_detect_rename():
    after = BASE.replace("def test_a", "def test_renamed")
    assert detect_tampering(fps(BASE), fps(after))[0].kind == "renamed"


def test_strengthening_is_fine():
    after = BASE.replace("    assert 2 == 2\n", "    assert 2 == 2\n    assert 3 == 3\n")
    assert detect_tampering(fps(BASE), fps(after)) == []
    assert new_or_changed(fps(BASE), fps(after)) == ["tests/test_x.py::test_a"]
