from __future__ import annotations

import pytest

from pcp_verifier.checkers import safety
from pcp_verifier.checkers.safety_rules import RULES, scan_line
from pcp_verifier.contracts import PatchContext

AWS = "AKIA" + "IOSFODNN7EXAMPLE"  # split so this file itself never trips secret scanners
GHP = "ghp_" + "a" * 36
SK = "sk-" + "proj-" + "A1b2C3d4E5f6G7h8I9j0K1"

MATCH = {
    "private_key": "-----BEGIN RSA PRIVATE KEY-----",
    "aws_access_key": f'key = "{AWS}"',
    "github_token": f"token = '{GHP}'",
    "openai_style_key": f"OPENAI = '{SK}'",
    "slack_token": "x = 'xoxb-123456789012-abcdef'",
    "hardcoded_password": 'password = "hunter22"',
    "bearer_token": 'headers = {"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz123"}',
    "eval": "result = eval(user_input)",
    "exec": "exec(code)",
    "shell_true": "subprocess.run(cmd, shell=True)",
    "os_system": "os.system('ls')",
    "rm_rf": "cmd = 'rm -rf /tmp/build'",
    "shutil_rmtree_root": "shutil.rmtree('/')",
    "drop_table": 'cur.execute("DROP TABLE users")',
    "pickle_loads": "obj = pickle.loads(blob)",
    "yaml_load": "cfg = yaml.load(f)",
    "tls_verify_off": "requests.get(url, verify=False)",
}
NO_MATCH = {
    "private_key": "# public key goes here",
    "aws_access_key": "key = os.environ['AWS_ACCESS_KEY_ID']",
    "github_token": "token = os.environ['GITHUB_TOKEN']",
    "openai_style_key": "risk-score = 1",
    "slack_token": "x = 'xox'",
    "hardcoded_password": "password = os.environ['PASSWORD']",
    "bearer_token": 'headers = {"Authorization": f"Bearer {token}"}',
    "eval": "model.eval()",
    "exec": "cursor.executemany(q)",
    "shell_true": "subprocess.run(cmd, shell=False)",
    "os_system": "os.path.join(a, b)",
    "rm_rf": "rm -i file",
    "shutil_rmtree_root": "shutil.rmtree(build_dir)",
    "drop_table": "drop_tables_flag = False",
    "pickle_loads": "json.loads(blob)",
    "yaml_load": "cfg = yaml.load(f, Loader=yaml.SafeLoader)",
    "tls_verify_off": "requests.get(url, verify=True)",
}


def test_every_rule_has_cases():
    assert {r.id for r in RULES} == set(MATCH) == set(NO_MATCH)


@pytest.mark.parametrize("rule_id", sorted(MATCH))
def test_rule_matches(rule_id):
    assert rule_id in {r.id for r, _ in scan_line(MATCH[rule_id], is_python=True)}


@pytest.mark.parametrize("rule_id", sorted(NO_MATCH))
def test_rule_does_not_match(rule_id):
    assert rule_id not in {r.id for r, _ in scan_line(NO_MATCH[rule_id], is_python=True)}


def test_python_only_rules_skip_other_files():
    assert scan_line("eval(x)", is_python=False) == []


def test_masked_placeholder_is_not_a_secret():
    assert scan_line("SECRET_KEY = '********'", is_python=False) == []


def test_dummy_password_in_tests_is_skipped_but_real_keys_are_not():
    assert scan_line('app.config.update(SECRET_KEY="dev-secret")', True, is_test=True) == []
    assert scan_line('app.config.update(SECRET_KEY="dev-secret")', True, is_test=False)
    assert scan_line(f'KEY = "{AWS}"', True, is_test=True)


def _ctx(diff: str) -> PatchContext:
    return PatchContext(
        patch_id="p",
        attempt=1,
        task="t",
        repo_root=".",
        shadow_root=".",
        diff=diff,
        changed_files=[],
        hunks=[],
    )


def _diff(path, removed, added):
    rm = "".join(f"-{line}\n" for line in removed)
    ad = "".join(f"+{line}\n" for line in added)
    return f"--- a/{path}\n+++ b/{path}\n@@ -1,{len(removed) + 1} +1,{len(added) + 1} @@\n ctx\n{rm}{ad}"


async def test_secret_is_critical_and_masked():
    res = await safety.run(_ctx(_diff("src/a.py", [], [f'KEY = "{AWS}"'])))
    assert res.status == "critical" and res.risk_modifier == 90
    f = res.findings[0]
    assert f.type == "secret" and f.line_start == 2
    assert AWS not in f.evidence and "AKIA" in f.evidence  # masked


async def test_dangerous_call_is_warning():
    res = await safety.run(_ctx(_diff("src/a.py", [], ["subprocess.run(c, shell=True)"])))
    assert res.status == "warning" and res.risk_modifier == 60


async def test_removed_guard():
    res = await safety.run(
        _ctx(_diff("src/a.py", ["try:", "    x()", "except ValueError:", "    pass"], ["x()"]))
    )
    assert [f.type for f in res.findings] == ["removed_guard"]


async def test_removed_lines_are_not_scanned_for_secrets():
    res = await safety.run(_ctx(_diff("src/a.py", [f'KEY = "{AWS}"'], ["KEY = os.environ['K']"])))
    assert res.status == "pass"


async def test_clean_patch_passes():
    res = await safety.run(_ctx(_diff("src/a.py", ["x = 1"], ["x = 2"])))
    assert (res.status, res.risk_modifier, res.findings) == ("pass", 0, [])
