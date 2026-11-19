from __future__ import annotations

from pcp_verifier.checkers import scope
from pcp_verifier.contracts import PatchContext


def _file(path, body_old=("a",), body_new=("b",)):
    rm = "".join(f"-{x}\n" for x in body_old)
    ad = "".join(f"+{x}\n" for x in body_new)
    return f"--- a/{path}\n+++ b/{path}\n@@ -1,{len(body_old)} +1,{len(body_new)} @@\n{rm}{ad}"


def _ctx(task, *files, repo="."):
    return PatchContext(
        patch_id="p",
        attempt=1,
        task=task,
        repo_root=str(repo),
        shadow_root=str(repo),
        diff="".join(files),
        changed_files=[],
        hunks=[],
    )


HELPERS = _file("src/flask/helpers.py", body_new=("def get_debug_flag(): ...",))


async def test_related_file_passes():
    r = await scope.run(_ctx("make get_debug_flag accept off", HELPERS))
    assert r.status == "pass"


async def test_protected_path_is_critical():
    r = await scope.run(_ctx("fix helpers", _file(".env", body_new=("SECRET=1",))))
    assert r.status == "critical"


async def test_ci_edit_warns_unless_asked():
    f = _file(".github/workflows/ci.yml", body_new=("on: push",))
    asked = await scope.run(_ctx("update the CI workflow", f))
    unasked = await scope.run(_ctx("fix get_debug_flag", f))
    assert any("ci file" in x.message for x in unasked.findings)
    assert not any("ci file" in x.message for x in asked.findings)


async def test_unrelated_file_warns():
    r = await scope.run(
        _ctx(
            "make get_debug_flag accept off",
            HELPERS,
            _file("src/flask/sessions.py", body_new=("COOKIE = 2",)),
        )
    )
    assert [f.file for f in r.findings if f.type == "out_of_scope"] == ["src/flask/sessions.py"]
    assert r.risk_modifier == 30


async def test_docs_allowed_when_task_mentions_docs():
    r = await scope.run(
        _ctx(
            "add a flask config command that masks secrets, with a test and docs",
            _file("src/flask/cli.py", body_new=("def config_command(): ...",)),
            _file("docs/cli.rst", body_new=("Run the config command like this.",)),
        )
    )
    assert r.status == "pass"


async def test_source_relevant_when_it_defines_task_symbol(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "m.py").write_text("TRUE = {1}\n\ndef parse_bool(v):\n    return v\n")
    f = _file("src/m.py", body_old=("TRUE = {1}",), body_new=("TRUE = {1, 2}",))
    r = await scope.run(_ctx("parse_bool should accept on", f, repo=tmp_path))
    assert r.status == "pass"


async def test_big_rewrite(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "mod.py").write_text("\n".join(f"x{i} = {i}" for i in range(20)) + "\n")
    old = [f"x{i} = {i}" for i in range(16)]
    new = [f"y{i} = {i}" for i in range(16)]
    r = await scope.run(_ctx("rename mod variables", _file("src/mod.py", old, new), repo=tmp_path))
    assert "big_rewrite" in {f.type for f in r.findings}
