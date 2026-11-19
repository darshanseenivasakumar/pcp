"""Shared helpers for checkers. Every checker is `async def run(ctx) -> CheckResult`."""

from __future__ import annotations

import contextvars
import re
from dataclasses import dataclass, field
from functools import lru_cache

from pcp_verifier.contracts import CheckResult, Finding, PatchContext
from pcp_verifier.core.diffparse import ParsedDiff, parse_diff

# The pipeline sets this so checkers that run processes (coverage) use the
# registered, cancellable sandbox instead of spawning untracked ones.
current_sandbox: contextvars.ContextVar = contextvars.ContextVar("pcp_sandbox", default=None)


@lru_cache(maxsize=64)
def _parse(diff: str) -> ParsedDiff:
    return parse_diff(diff)


def parsed(ctx: PatchContext) -> ParsedDiff:
    return _parse(ctx.diff)


@dataclass
class ResultBuilder:
    """Collects findings and keeps the worst modifier/status (max, never sum)."""

    checker: str
    findings: list[Finding] = field(default_factory=list)
    modifier: int = 0
    critical: bool = False
    actions: list[str] = field(default_factory=list)

    def add(self, modifier: int, *, critical: bool = False, action: str = "", **finding) -> Finding:
        f = Finding(id=f"{self.checker}-{len(self.findings) + 1}", **finding)
        self.findings.append(f)
        self.bump(modifier, critical=critical, action=action)
        return f

    def bump(self, modifier: int, *, critical: bool = False, action: str = "") -> None:
        self.modifier = max(self.modifier, min(100, modifier))
        self.critical = self.critical or critical
        if action and action not in self.actions:
            self.actions.append(action)

    def build(self) -> CheckResult:
        status = "critical" if self.critical else ("warning" if self.modifier > 0 else "pass")
        return CheckResult(
            checker=self.checker,
            risk_modifier=self.modifier,
            status=status,
            findings=self.findings,
            recommended_action="; ".join(self.actions) or "none",
        )


_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "also", "make", "add", "adds", "new",
    "should", "must", "when", "from", "into", "treat", "use", "using", "all", "any",
    "not", "are", "was", "has", "have", "its", "it", "as", "to", "of", "in", "on",
    "a", "an", "is", "be", "by", "or", "so", "if", "do", "does", "can", "test",
    "tests", "fix", "bug", "change", "update", "code", "file", "files", "command",
}  # fmt: skip


def tokens(text: str) -> set[str]:
    """Identifier-ish tokens, with snake_case and CamelCase split out too."""
    out: set[str] = set()
    for word in _WORD.findall(text):
        low = word.lower()
        if len(low) >= 3 and low not in STOPWORDS:
            out.add(low)
        for part in re.split(r"_+", _CAMEL.sub("_", word)):
            p = part.lower()
            if len(p) >= 3 and p not in STOPWORDS:
                out.add(p)
    return out


def mask(secret_text: str) -> str:
    """Never echo a secret into the verdict/journal: keep 4 chars, star the rest."""
    s = secret_text.strip()
    return s[:4] + "*" * max(4, min(16, len(s) - 4))
