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

verify_launch_output() {
	local missing=0
	local required_files=(
		"$ROOT/out/main.js"
		"$ROOT/out/vs/code/electron-main/main.js"
		"$ROOT/out/vs/platform/environment/node/userDataPath.js"
		"$ROOT/out/vs/platform/update/common/update.config.contribution.js"
	)

	for required_file in "${required_files[@]}"; do
		if [[ ! -f "$required_file" ]]; then
			echo "Missing generated launch file: $required_file" >&2
			missing=1
		fi
	done

	return "$missing"
}

echo "Preparing Electron..."
npm run electron

echo "Compiling..."
npm run compile

echo "Regenerating launch output..."
npm run transpile-client

if ! verify_launch_output; then
	echo "Generated output was incomplete. Rebuilding it once more..."
	npm run transpile-client
fi

if ! verify_launch_output; then
	echo "Generated output is still incomplete. Fix the build errors above, then run this again." >&2
	exit 1
fi

RUN_STAMP="$(date +%s)"
LOG_FILE="/tmp/backboard-studio-dev-$RUN_STAMP.launch.log"

echo "Launching Backboard Studio..."
/usr/bin/nohup "$ROOT/run-backboard-ide.sh" > "$LOG_FILE" 2>&1 &

echo "Log: $LOG_FILE"
echo "Press Ctrl-C to stop following the log. The app will keep running."
tail -f "$LOG_FILE"
