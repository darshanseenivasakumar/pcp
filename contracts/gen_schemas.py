"""Regenerate contracts/schemas/*.schema.json from the Pydantic models.

Usage:  python contracts/gen_schemas.py          (write)
        python contracts/gen_schemas.py --check  (exit 1 if schemas are stale)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pcp_contracts import CONTRACTS_VERSION, MODELS

SCHEMA_DIR = HERE / "schemas"


def render(name: str) -> str:
    schema = MODELS[name].model_json_schema()
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"pcp/{name}.schema.json",
        "x-contracts-version": CONTRACTS_VERSION,
        **schema,
    }
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> int:
    check = "--check" in sys.argv
    SCHEMA_DIR.mkdir(exist_ok=True)
    stale = []
    for name in MODELS:
        path = SCHEMA_DIR / f"{name}.schema.json"
        text = render(name)
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                stale.append(path.name)
        else:
            path.write_text(text, encoding="utf-8", newline="\n")
    if stale:
        print("stale schemas (run python contracts/gen_schemas.py):", ", ".join(stale))
        return 1
    print("schemas ok" if check else f"wrote {len(MODELS)} schemas to {SCHEMA_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
