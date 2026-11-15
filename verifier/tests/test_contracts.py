"""Every shared example validates against both its Pydantic model and its JSON schema."""

from __future__ import annotations

import json
import subprocess
import sys

import jsonschema
import pytest
from conftest import EXAMPLES, load_example

from pcp_verifier.contracts import CONTRACTS_DIR, MODELS, Verdict, model_for_example

EXAMPLE_FILES = sorted(p.name for p in EXAMPLES.glob("*.json"))


def _items(name):
    data = load_example(name)
    return data if isinstance(data, list) else [data]


@pytest.mark.parametrize("name", EXAMPLE_FILES)
def test_example_validates_pydantic(name):
    model = model_for_example(name)
    for item in _items(name):
        model.model_validate(item)


@pytest.mark.parametrize("name", EXAMPLE_FILES)
def test_example_validates_json_schema(name):
    model = model_for_example(name)
    key = next(k for k, v in MODELS.items() if v is model)
    schema = json.loads(
        (CONTRACTS_DIR / "schemas" / f"{key}.schema.json").read_text(encoding="utf-8")
    )
    for item in _items(name):
        jsonschema.validate(item, schema)


def test_every_model_has_an_example():
    covered = {model_for_example(n) for n in EXAMPLE_FILES}
    missing = [k for k, m in MODELS.items() if m not in covered]
    assert not missing, f"add examples for: {missing}"


def test_schemas_are_up_to_date():
    r = subprocess.run(
        [sys.executable, str(CONTRACTS_DIR / "gen_schemas.py"), "--check"],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr


def test_unknown_fields_fail_loudly():
    data = load_example("verdict_review.json") | {"surprise": 1}
    with pytest.raises(ValueError):
        Verdict.model_validate(data)


@pytest.mark.parametrize(
    "patch, msg",
    [
        ({"decision": "REVIEW", "score": 69, "score_history": [69]}, "score < 70"),
        ({"decision": "REPAIR", "repair_instructions": None}, "repair_instructions"),
        ({"score_history": [45, 80]}, "score_history"),
        ({"unproven": False, "proof": None}, "unproven"),
    ],
)
def test_verdict_invariants(patch, msg):
    data = load_example("verdict_review.json") | patch
    if patch.get("decision") == "REPAIR":
        data["score"], data["score_history"] = 50, [50]
    with pytest.raises(ValueError, match=msg):
        Verdict.model_validate(data)


def test_critical_forces_block():
    data = load_example("verdict_block.json") | {"decision": "REVIEW"}
    with pytest.raises(ValueError, match="critical"):
        Verdict.model_validate(data)
