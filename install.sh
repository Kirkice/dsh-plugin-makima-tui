#!/usr/bin/env bash
# Install makima-tui into a dsh profile from this checkout.
#
#   git clone https://github.com/agentforce314/dsh-makimaTUI.git
#   cd dsh-makimaTUI && ./install.sh
#   dsh --profile makima-tui    (or: ./bin/makima-tui.js)
set -euo pipefail

PROFILE="${MAKIMA_TUI_PROFILE:-makima-tui}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: the dsh CLI is not on PATH — install deepseek-harness first:" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required to build the plugin" >&2
  exit 1
fi

echo "==> building makima-tui in $HERE"
(cd "$HERE" && npm install && npm run build)

echo "==> installing into dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$HERE"

echo
echo "done. launch with:"
echo "  dsh --profile $PROFILE"
