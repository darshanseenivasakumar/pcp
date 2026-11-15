#!/usr/bin/env bash
# Start the PCP verifier (and, once P2 adds it, the extension dev host).
set -euo pipefail
cd "$(dirname "$0")/.."
PY=".venv/bin/python"; [ -x "$PY" ] || PY=".venv/Scripts/python"
[ -f .env ] && set -a && . ./.env && set +a
exec "$PY" -m uvicorn pcp_verifier.server:app --host "${PCP_HOST:-127.0.0.1}" --port "${PCP_PORT:-8765}" --app-dir verifier
# Person 2: start the extension dev host here, e.g. (cd extension && npm run watch) &
