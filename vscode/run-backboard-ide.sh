#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_ICON_SOURCE="$ROOT/resources/darwin/code.icns"
ISOLATED_PROFILE="${ISOLATED_PROFILE:-0}"
RUN_DIR="${RUN_DIR:-/tmp/backboard-studio-dev}"
NODE24="$HOME/.nvm/versions/node/v24.15.0/bin"

ENV_FILE="$ROOT/../.env"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

APP_BUNDLE=""
for candidate in "$ROOT/.build/electron/Backboard Studio Dev.app" "$ROOT/.build/electron/Backboard IDE.app" "$ROOT/.build/electron/Code - OSS.app"; do
	if [[ -d "$candidate" ]]; then
		APP_BUNDLE="$candidate"
		break
	fi
done

if [[ -z "$APP_BUNDLE" ]]; then
	echo "Missing dev app bundle under: $ROOT/.build/electron" >&2
	echo "Run: source \"\$HOME/.nvm/nvm.sh\" && nvm use && npm run electron && npm run compile-client" >&2
	exit 1
fi

APP_PLIST="$APP_BUNDLE/Contents/Info.plist"
if [[ -f "$APP_PLIST" ]]; then
	/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier io.backboard.studio.dev" "$APP_PLIST" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLName Backboard Studio Dev" "$APP_PLIST" 2>/dev/null || true
	/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLSchemes:0 backboard" "$APP_PLIST" 2>/dev/null || true
	touch "$APP_BUNDLE"
fi

APP_EXECUTABLE="$(basename "$APP_BUNDLE" .app)"
if [[ -f "$APP_PLIST" ]]; then
	PLIST_EXECUTABLE="$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_PLIST" 2>/dev/null || true)"
	if [[ -n "$PLIST_EXECUTABLE" ]]; then
		APP_EXECUTABLE="$PLIST_EXECUTABLE"
	fi
fi
APP="$APP_BUNDLE/Contents/MacOS/$APP_EXECUTABLE"
DEV_ICON_DEST="$APP_BUNDLE/Contents/Resources/$APP_EXECUTABLE.icns"

if [[ ! -x "$APP" ]]; then
	echo "Missing dev app binary at: $APP" >&2
	echo "Run: source \"\$HOME/.nvm/nvm.sh\" && nvm use && npm run electron && npm run compile-client" >&2
	exit 1
fi

if [[ -f "$DEV_ICON_SOURCE" ]]; then
	cp "$DEV_ICON_SOURCE" "$DEV_ICON_DEST"
	touch "$APP_BUNDLE"
fi

if [[ -d "$NODE24" ]]; then
	export PATH="$NODE24:$PATH"
fi

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

echo "Starting Backboard Studio Dev"
if [[ "$ISOLATED_PROFILE" == "1" ]]; then
	mkdir -p "$RUN_DIR/user-data" "$RUN_DIR/extensions" "$RUN_DIR/shared-data"
	echo "Profile: $RUN_DIR/user-data"
else
	echo "Profile: default"
fi
echo "Output: terminal"

ARGS=(
	--disable-extension=vscode.vscode-api-tests
	--new-window
	--disable-layout-restore
)

if [[ "$ISOLATED_PROFILE" == "1" ]]; then
	ARGS+=(
		--user-data-dir "$RUN_DIR/user-data"
		--extensions-dir "$RUN_DIR/extensions"
		--shared-data-dir "$RUN_DIR/shared-data"
	)
fi

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

echo "PID: $$"
exec "$APP" . "${ARGS[@]}"
