#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/.build/electron/Code - OSS.app/Contents/MacOS/Code - OSS"
APP_BUNDLE="$ROOT/.build/electron/Code - OSS.app"
DEV_ICON_SOURCE="$ROOT/resources/darwin/code.icns"
DEV_ICON_DEST="$APP_BUNDLE/Contents/Resources/Code - OSS.icns"
RUN_DIR="${RUN_DIR:-/tmp/backboard-ide-$(date +%s)}"
NODE24="$HOME/.nvm/versions/node/v24.15.0/bin"

if [[ ! -x "$APP" ]]; then
	echo "Missing Code OSS app binary at: $APP" >&2
	echo "Run: PATH=\"\$HOME/.nvm/versions/node/v24.15.0/bin:\$PATH\" npm run transpile && node build/lib/preLaunch.ts" >&2
	exit 1
fi

if [[ -f "$DEV_ICON_SOURCE" ]]; then
	cp "$DEV_ICON_SOURCE" "$DEV_ICON_DEST"
	touch "$APP_BUNDLE"
fi

if [[ -d "$NODE24" ]]; then
	export PATH="$NODE24:$PATH"
fi

mkdir -p "$RUN_DIR/user-data" "$RUN_DIR/extensions" "$RUN_DIR/shared-data"
mkdir -p "$ROOT/out"

CODICON_SOURCE="$ROOT/node_modules/@vscode/codicons/dist/codicon.ttf"
CODICON_SRC_DEST="$ROOT/src/vs/base/browser/ui/codicons/codicon/codicon.ttf"
CODICON_OUT_DEST="$ROOT/out/vs/base/browser/ui/codicons/codicon/codicon.ttf"

if [[ -f "$CODICON_SOURCE" ]]; then
	mkdir -p "$(dirname "$CODICON_SRC_DEST")" "$(dirname "$CODICON_OUT_DEST")"
	cp "$CODICON_SOURCE" "$CODICON_SRC_DEST"
	cp "$CODICON_SOURCE" "$CODICON_OUT_DEST"
else
	echo "Missing codicon font at: $CODICON_SOURCE" >&2
	echo "Run: PATH=\"\$HOME/.nvm/versions/node/v24.15.0/bin:\$PATH\" npm install" >&2
	exit 1
fi

if [[ ! -f "$ROOT/out/nls.messages.json" ]]; then
	printf '{}\n' > "$ROOT/out/nls.messages.json"
fi

echo "Starting Backboard IDE"
echo "Profile: $RUN_DIR/user-data"
echo "Log: $RUN_DIR/code.log"

ARGS=(
	--user-data-dir "$RUN_DIR/user-data"
	--extensions-dir "$RUN_DIR/extensions"
	--shared-data-dir "$RUN_DIR/shared-data"
	--disable-extension=vscode.vscode-api-tests
)

if [[ "${DEBUG_IDE:-}" == "1" ]]; then
	ARGS+=(--verbose)
fi

if [[ "${DISABLE_GPU:-}" == "1" ]]; then
	ARGS+=(--disable-gpu)
fi

export NODE_ENV=development
export VSCODE_DEV=1
export VSCODE_CLI=1
export ELECTRON_ENABLE_STACK_DUMPING=1
export ELECTRON_ENABLE_LOGGING=1

"$APP" . "${ARGS[@]}" > "$RUN_DIR/code.log" 2>&1 &
PID=$!

sleep 2

osascript - "$PID" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
	set appPid to item 1 of argv as integer
	tell application "System Events"
		set frontmost of the first process whose unix id is appPid to true
	end tell
end run
APPLESCRIPT

echo "PID: $PID"
wait "$PID"
