import pytest

from tiny.mathx import clamp, parse_bool, safe_div


def test_clamp_inside():
    assert clamp(5, 0, 10) == 5


def test_clamp_edges():
    assert clamp(-1, 0, 10) == 0
    assert clamp(11, 0, 10) == 10


def test_clamp_bad_range():
    with pytest.raises(ValueError):
        clamp(1, 10, 0)


@pytest.mark.parametrize("value", ["1", "true", "YES", " yes "])
def test_parse_bool_true(value):
    assert parse_bool(value) is True


@pytest.mark.parametrize("value", [None, "", "0", "false", "nope"])
def test_parse_bool_false(value):
    assert parse_bool(value) is False


def test_safe_div():
    assert safe_div(6, 3) == 2
    assert safe_div(1, 0) == 0.0
    assert safe_div(1, 0, default=-1) == -1
