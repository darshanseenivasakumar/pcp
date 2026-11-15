"""Load the shared contracts from <repo>/contracts/pcp_contracts.py.

The contracts live outside this package (they are shared with Person 2), so we
load them by path instead of copying them. Override the location with
PCP_CONTRACTS_DIR.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = Path(os.environ.get("PCP_CONTRACTS_DIR", REPO_ROOT / "contracts")).resolve()


def _load():
    if "pcp_contracts" in sys.modules:
        return sys.modules["pcp_contracts"]
    path = CONTRACTS_DIR / "pcp_contracts.py"
    if not path.exists():
        raise ImportError(f"shared contracts not found at {path} (set PCP_CONTRACTS_DIR)")
    spec = importlib.util.spec_from_file_location("pcp_contracts", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["pcp_contracts"] = module
    spec.loader.exec_module(module)
    return module


_c = _load()

CONTRACTS_VERSION = _c.CONTRACTS_VERSION
MAX_ATTEMPTS = _c.MAX_ATTEMPTS
REPAIR_THRESHOLD = _c.REPAIR_THRESHOLD
REVIEW_THRESHOLD = _c.REVIEW_THRESHOLD
MODELS = _c.MODELS
model_for_example = _c.model_for_example

CheckResult = _c.CheckResult
Event = _c.Event
Finding = _c.Finding
FrozenManifest = _c.FrozenManifest
Health = _c.Health
Hunk = _c.Hunk
HunkEvidence = _c.HunkEvidence
LLMMessage = _c.LLMMessage
LLMRequest = _c.LLMRequest
LLMResponse = _c.LLMResponse
PatchContext = _c.PatchContext
Proof = _c.Proof
RunResult = _c.RunResult
TamperEvent = _c.TamperEvent
Verdict = _c.Verdict
VerifyRequest = _c.VerifyRequest
VerifyResponse = _c.VerifyResponse
