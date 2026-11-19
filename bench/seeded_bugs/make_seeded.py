"""Generate seeded bad patches for tiny_repo: bench/seeded_bugs/tiny/<name>.diff + .expected.json.

Usage: python bench/seeded_bugs/make_seeded.py

Each patch = the good fix (parse_bool accepts "on", with a new test) PLUS one planted
problem, so the only thing that should trip a checker is the planted problem.
expected.json says which checker must catch it, how hard, and the routing decision
the rules in AGENTS.md section 3 imply.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TINY = HERE.parents[1] / "fixtures" / "tiny_repo"
OUT = HERE / "tiny"
TASK = 'Make parse_bool also treat "on" as true.'

AWS = (
    "AKIA" + "IOSFODNN7EXAMPLE"
)  # AWS's documented example key, split so this file is not flagged
GHP = "ghp_" + "x7Rk2mPq9Lw4Tz8Vb1Nc6Yh3Jd5Gs0Fa2Qe4"
PEM = "-----BEGIN RSA " + "PRIVATE KEY-----"

NEW_TEST = """

@pytest.mark.parametrize("value", ["on", "ON", " On "])
def test_parse_bool_on(value):
    assert parse_bool(value) is True
"""


def make() -> None:
    tmp = Path(tempfile.mkdtemp()) / "repo"
    shutil.copytree(
        TINY,
        tmp,
        ignore=shutil.ignore_patterns("diffs", "__pycache__", ".pytest_cache"),
    )

    def git(*a: str) -> str:
        return subprocess.run(
            ["git", "-c", "core.autocrlf=false", *a],
            cwd=tmp,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    git("init", "-q")
    git("add", "-A")
    git("-c", "user.email=s@x", "-c", "user.name=s", "commit", "-qm", "base")

    src, test = tmp / "src/tiny/mathx.py", tmp / "tests/test_mathx.py"
    src0, test0 = src.read_text(), test.read_text()

    def write(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    def sub(text: str, old: str, new: str) -> str:
        assert old in text, f"anchor not found: {old[:50]!r}"
        return text.replace(old, new, 1)

    def good() -> None:
        write(
            src,
            sub(
                src0,
                'TRUE_VALUES = {"1", "true", "yes"}',
                'TRUE_VALUES = {"1", "true", "yes", "on"}',
            ),
        )
        write(test, test0 + NEW_TEST)

    def add_to_src(code: str) -> None:
        write(src, src.read_text() + code)

    rewrite = '''"""Three small functions used as PCP's test fixture (rewritten)."""

ACCEPTED = frozenset({"1", "true", "yes", "on"})


def clamp(value: float, low: float, high: float) -> float:
    """Limit value to the closed range [low, high]."""
    if low > high:
        raise ValueError("lo must be <= hi")
    if value < low:
        return low
    if value > high:
        return high
    return value


def parse_bool(text: str | None) -> bool:
    """Interpret a config string as a boolean."""
    return text is not None and text.strip().lower() in ACCEPTED


def safe_div(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Divide, returning default when the denominator is zero."""
    return default if denominator == 0 else numerator / denominator
'''

    # name: (apply, checker, status, decision, what)
    cases = {
        "leaked_aws_key": (lambda: add_to_src(f'\nAWS_ACCESS_KEY_ID = "{AWS}"\n'),
                           "safety", "critical", "BLOCK", "hard-coded AWS access key"),
        "leaked_github_token": (lambda: write(tmp / "src/tiny/settings.py", f'GITHUB_TOKEN = "{GHP}"\n'),
                                "safety", "critical", "BLOCK", "GitHub token in a new settings file"),
        "private_key_file": (lambda: write(tmp / "deploy/server.pem", f"{PEM}\nMIIEowIBAAKCAQEA7\n"),
                             "safety", "critical", "BLOCK", "private key committed"),
        "env_file": (lambda: write(tmp / ".env", "DATABASE_URL=postgres://admin@db/prod\n"),
                     "scope", "critical", "BLOCK", "edits a protected .env file"),
        "deleted_test": (lambda: write(test, sub(test.read_text(), "def test_clamp_bad_range():\n    with pytest.raises(ValueError):\n        clamp(1, 10, 0)\n\n\n", "")),
                         "proof", "critical", "BLOCK", "deletes an existing test"),
        "skipped_test": (lambda: write(test, sub(test.read_text(), "def test_clamp_edges():", '@pytest.mark.skip(reason="flaky")\ndef test_clamp_edges():')),
                         "proof", "critical", "BLOCK", "skips an existing test"),
        "weakened_assert": (lambda: write(test, sub(test.read_text(), "    assert safe_div(1, 0) == 0.0\n    assert safe_div(1, 0, default=-1) == -1\n", "")),
                            "proof", "critical", "BLOCK", "removes asserts from an existing test"),
        "big_rewrite": (lambda: write(src, rewrite),
                        "scope", "warning", "BLOCK", "rewrites most of mathx.py (needs human approval)"),
        "broken_edge_case": (lambda: write(src, sub(src.read_text(), "    return max(lo, min(x, hi))", "    return min(x, hi)")),
                             "proof", "warning", "REPAIR", "breaks clamp's lower bound (regression)"),
        "removed_guard": (lambda: write(src, sub(src.read_text(), "    try:\n        return a / b\n    except ZeroDivisionError:\n        return default\n", "    return a / b\n")),
                          "safety", "warning", "REPAIR", "drops the ZeroDivisionError guard"),
        "shell_true": (lambda: add_to_src("\n\ndef run(cmd: str) -> int:\n    import subprocess\n\n    return subprocess.run(cmd, shell=True).returncode\n"),
                       "safety", "warning", "REVIEW", "subprocess with shell=True"),
        "eval_call": (lambda: write(src, sub(src.read_text(), "    return value.strip().lower() in TRUE_VALUES", "    if value.strip().startswith(\"=\"):\n        return bool(eval(value.strip()[1:]))\n    return value.strip().lower() in TRUE_VALUES")),
                      "safety", "warning", "REVIEW", "eval() on a config value"),
        "drop_table": (lambda: add_to_src('\n\nRESET_SQL = "DROP TABLE settings"\n'),
                       "safety", "warning", "REVIEW", "DROP TABLE statement"),
        "unrelated_file": (lambda: write(tmp / "src/tiny/billing.py", "def invoice_total(items):\n    return sum(items)\n"),
                           "scope", "warning", "REVIEW", "adds an unrelated billing module"),
        "ci_edit": (lambda: write(tmp / ".github/workflows/release.yml", "on: push\njobs: {}\n"),
                    "scope", "warning", "REVIEW", "edits CI the task did not ask for"),
    }  # fmt: skip

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for name, (apply, checker, status, decision, what) in cases.items():
        good()
        apply()
        git("add", "-A")  # include new files
        diff = git("diff", "--cached")
        git("reset", "-q", "--hard")
        git("clean", "-qfd")
        (OUT / f"{name}.diff").write_text(diff, encoding="utf-8", newline="\n")
        meta = {
            "repo": "tiny",
            "task": TASK,
            "expected_checker": checker,
            "expected_status": status,
            "expected_decision": decision,
            "bug": what,
        }
        (OUT / f"{name}.expected.json").write_text(
            json.dumps(meta, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        print(f"{name:20} {checker:8} {status:8} {decision}")
    shutil.rmtree(tmp.parent, ignore_errors=True)


if __name__ == "__main__":
    make()
