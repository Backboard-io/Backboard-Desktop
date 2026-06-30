#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/package.json" || ! -x "$ROOT/run-backboard-ide.sh" ]]; then
	echo "Run this from the VS Code / Backboard Studio checkout, or keep it in that folder." >&2
	exit 1
fi

CODEX_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
NVM_NODE="$HOME/.nvm/versions/node/v24.15.0/bin"

if [[ -d "$CODEX_NODE" ]]; then
	export PATH="$CODEX_NODE:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
elif [[ -d "$NVM_NODE" ]]; then
	export PATH="$NVM_NODE:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
else
	export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "npm was not found. Install Node.js first, then run this again." >&2
	exit 1
fi

echo "Preparing Electron..."
npm run electron

echo "Compiling..."
npm run compile

echo "Regenerating launch output..."
npm run transpile-client

RUN_STAMP="$(date +%s)"
LOG_FILE="/tmp/backboard-studio-dev-$RUN_STAMP.launch.log"

echo "Launching Backboard Studio..."
/usr/bin/nohup "$ROOT/run-backboard-ide.sh" > "$LOG_FILE" 2>&1 &

echo "Log: $LOG_FILE"
echo "Press Ctrl-C to stop following the log. The app will keep running."
tail -f "$LOG_FILE"
