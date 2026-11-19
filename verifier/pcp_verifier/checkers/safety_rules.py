"""Regex rules for the safety checker. Deterministic, runs before any tool or LLM."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Rule:
    id: str
    kind: str  # "secret" | "dangerous_call"
    pattern: re.Pattern
    modifier: int
    message: str
    python_only: bool = False
    skip_tests: bool = False  # dummy fixture values in tests are not leaks


def _r(p: str, flags: int = 0) -> re.Pattern:
    return re.compile(p, flags)


SECRET_MODIFIER = 90

RULES: list[Rule] = [
    # ---- secrets: critical, modifier 90, no LLM call
    Rule("private_key", "secret", _r(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY"), SECRET_MODIFIER, "Private key committed"),
    Rule("aws_access_key", "secret", _r(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), SECRET_MODIFIER, "AWS access key ID"),
    Rule("github_token", "secret", _r(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b"), SECRET_MODIFIER, "GitHub token"),
    Rule("openai_style_key", "secret", _r(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}"), SECRET_MODIFIER, "API secret key (sk-...)"),
    Rule("slack_token", "secret", _r(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), SECRET_MODIFIER, "Slack token"),
    # masked placeholders like '********' are not secrets; dummy values in tests are skipped
    Rule("hardcoded_password", "secret", _r(r"""(?i)\b(?:password|passwd|pwd|secret_key|api_key)\s*[:=]\s*["'](?![*x.]+["'])[^"'\s]{4,}["']"""), SECRET_MODIFIER, "Hard-coded password or secret", skip_tests=True),
    Rule("bearer_token", "secret", _r(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{20,}"), SECRET_MODIFIER, "Hard-coded bearer token"),
    # ---- dangerous calls: warning
    Rule("eval", "dangerous_call", _r(r"(?<![\w.])eval\s*\("), 60, "eval() runs arbitrary code", python_only=True),
    Rule("exec", "dangerous_call", _r(r"(?<![\w.])exec\s*\("), 60, "exec() runs arbitrary code", python_only=True),
    Rule("shell_true", "dangerous_call", _r(r"shell\s*=\s*True"), 60, "subprocess with shell=True (shell injection)", python_only=True),
    Rule("os_system", "dangerous_call", _r(r"\bos\.(?:system|popen)\s*\("), 60, "os.system/os.popen runs a shell", python_only=True),
    Rule("rm_rf", "dangerous_call", _r(r"\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b"), 70, "rm -rf"),
    Rule("shutil_rmtree_root", "dangerous_call", _r(r"shutil\.rmtree\(\s*['\"](?:/|~|[A-Za-z]:\\\\?)['\"]"), 70, "rmtree on a root path", python_only=True),
    Rule("drop_table", "dangerous_call", _r(r"(?i)\bDROP\s+(?:TABLE|DATABASE)\b"), 70, "DROP TABLE/DATABASE"),
    Rule("pickle_loads", "dangerous_call", _r(r"\bpickle\.loads?\s*\("), 40, "pickle.load(s) on untrusted data runs code", python_only=True),
    Rule("yaml_load", "dangerous_call", _r(r"\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)"), 40, "yaml.load without SafeLoader", python_only=True),
    Rule("tls_verify_off", "dangerous_call", _r(r"verify\s*=\s*False"), 40, "TLS verification disabled", python_only=True),
]  # fmt: skip

GUARD_START = re.compile(r"^\s*(?:try\s*:|except\b.*:|finally\s*:)")


def scan_line(text: str, is_python: bool, is_test: bool = False) -> list[tuple[Rule, re.Match]]:
    hits = []
    for rule in RULES:
        if (rule.python_only and not is_python) or (rule.skip_tests and is_test):
            continue
        m = rule.pattern.search(text)
        if m:
            hits.append((rule, m))
    return hits
