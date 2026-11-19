"""Docker sandbox: real network isolation and no leaked containers. Skipped without Docker."""

from __future__ import annotations

import shutil
import subprocess

import pytest
from conftest import tiny_diff

from pcp_verifier.core.proof_runner import run_proof
from pcp_verifier.core.sandbox import DockerSandbox

IMAGE = "pcp-sandbox:py312"


def _docker_ready() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        r = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


pytestmark = pytest.mark.skipif(not _docker_ready(), reason=f"docker image {IMAGE} not available")


@pytest.fixture
def sb(tiny_repo):
    box = DockerSandbox(tiny_repo, "dockertest", image=IMAGE)
    box.prepare()
    yield box
    box.cleanup()


def test_network_is_blocked(sb):
    code = "import socket; socket.create_connection(('1.1.1.1', 53), timeout=3); print('ONLINE')"
    res = sb.exec(sb.python_cmd("-c", code), timeout=60)
    assert res.exit_code != 0 and "ONLINE" not in res.stdout


def test_patched_source_is_what_gets_imported(sb):
    sb.apply(tiny_diff("good"))
    res = sb.exec(
        sb.python_cmd("-c", "from tiny.mathx import parse_bool; print(parse_bool('on'))"),
        timeout=60,
    )
    assert res.stdout.strip() == "True", res.output


def test_timeout_kills_the_container(sb):
    res = sb.exec(sb.python_cmd("-c", "import time; time.sleep(120)"), timeout=4)
    assert res.timed_out
    names = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=20
    ).stdout.split()
    assert not set(names) & sb._containers


async def test_proof_in_docker_matches_local(tiny_repo, monkeypatch):
    monkeypatch.setenv("PCP_SANDBOX", "docker")
    out = await run_proof(repo_root=tiny_repo, diff=tiny_diff("good"))
    try:
        p = out.proof
        assert p.sandbox == f"docker:{IMAGE}"
        assert p.f2p_ok and p.p2p_ok and p.patched.passed == 16
    finally:
        if out.patched_sandbox:
            out.patched_sandbox.cleanup()
