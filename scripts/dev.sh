#!/usr/bin/env bash
# Start the PCP verifier and open VS Code with the PCP extension (PCP_NO_EDITOR=1 skips the editor).
set -euo pipefail
cd "$(dirname "$0")/.."
PY=".venv/bin/python"; [ -x "$PY" ] || PY=".venv/Scripts/python"
[ -f .env ] && set -a && . ./.env && set +a
# Person 2: build the extension and open VS Code with it on the demo repo (skip with PCP_NO_EDITOR=1).
if [ -z "${PCP_NO_EDITOR:-}" ] && command -v code >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  DEMO_REPO="${PCP_DEMO_REPO:-bench/repos/flask}"; [ -d "$DEMO_REPO" ] || DEMO_REPO="fixtures/tiny_repo"
  ( cd extension && { [ -d node_modules ] || npm ci --silent; } && npm run build --silent ) \
    && code --extensionDevelopmentPath="$PWD/extension" "$DEMO_REPO" &
fi
exec "$PY" -m uvicorn pcp_verifier.server:app --host "${PCP_HOST:-127.0.0.1}" --port "${PCP_PORT:-8765}" --app-dir verifier
