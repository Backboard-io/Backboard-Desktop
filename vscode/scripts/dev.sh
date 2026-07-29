#!/usr/bin/env bash
# Backboard Studio developer environment.
#
#   ./scripts/dev.sh              bring everything up: deps -> watcher -> launch (default)
#   ./scripts/dev.sh doctor       report on the local toolchain, tell you what is missing
#   ./scripts/dev.sh setup        install dependencies and fetch Electron
#   ./scripts/dev.sh watch        start the incremental build watcher only
#   ./scripts/dev.sh run          launch the app against whatever is currently built
#   ./scripts/dev.sh logs         follow the watcher log
#   ./scripts/dev.sh status       show what is running
#   ./scripts/dev.sh stop         stop the watcher and the app
#
# Once the watcher is up you do not rebuild by hand. Edit a file, then:
#   renderer / workbench code  ->  Cmd+R in the running window
#   main-process code          ->  the app relaunches itself (disable with --no-restart)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR="$ROOT/.build/dev"
WATCH_LOG="$STATE_DIR/watch.log"
APP_LOG="$STATE_DIR/app.log"
WATCH_PID_FILE="$STATE_DIR/watch.pid"
APP_PID_FILE="$STATE_DIR/app.pid"

REQUIRED_NODE="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
REQUIRED_NODE_MAJOR="${REQUIRED_NODE%%.*}"

# Files that must exist in out/ before the Electron main process can boot.
LAUNCH_FILES=(
	"out/bootstrap-esm.js"
	"out/main.js"
	"out/vs/code/electron-main/main.js"
	"out/vs/platform/environment/node/userDataPath.js"
)

# Rebuilt main-process output that requires a full relaunch rather than a window reload.
MAIN_PROCESS_PATHS=(
	"out/main.js"
	"out/bootstrap-esm.js"
	"out/vs/code/electron-main"
)

AUTO_RESTART=1

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m error\033[0m %s\n' "$*" >&2; exit 1; }

# --- toolchain -------------------------------------------------------------

# Node is not always on PATH in a GUI-launched shell, so look in the usual places.
bootstrap_path() {
	if command -v node >/dev/null 2>&1; then
		if node_major_ok; then return 0; fi
	fi
	local candidate
	for candidate in \
		"$HOME/.local/node-v$REQUIRED_NODE-darwin-$(uname -m | sed 's/x86_64/x64/')/bin" \
		"$HOME/.nvm/versions/node/v$REQUIRED_NODE/bin" \
		"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" \
		"$HOME/.local/bin" \
		/opt/homebrew/bin \
		/usr/local/bin
	do
		if [[ -x "$candidate/node" ]]; then
			export PATH="$candidate:$PATH"
			if node_major_ok; then return 0; fi
		fi
	done
	return 1
}

node_major_ok() {
	local major
	major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
	[[ "$major" == "$REQUIRED_NODE_MAJOR" ]]
}

have_native_toolchain() {
	xcode-select -p >/dev/null 2>&1 && [[ -n "$(command -v cc)" ]] && cc --version >/dev/null 2>&1
}

have_python() {
	python3 --version >/dev/null 2>&1
}

# cli-ts has no packaged binary in a dev checkout, so the agent host shells out to
# `bun run cli-ts/src/entrypoints/cli.tsx`. Without Bun the app launches but agent
# requests fail with BackboardSendFailed. See src/vs/platform/agentHost/node/cliTs.
bun_path() {
	local candidate
	for candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
		if [[ -x "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done
	command -v bun 2>/dev/null && return 0
	return 1
}

# Put Bun on PATH for the launched app, which inherits our environment.
export_bun_path() {
	local bun
	if bun="$(bun_path)"; then
		export PATH="$(dirname "$bun"):$PATH"
	fi
}

app_bundle() {
	local candidate
	for candidate in \
		"$ROOT/.build/electron/Backboard Studio Dev.app" \
		"$ROOT/.build/electron/Backboard Studio.app" \
		"$ROOT/.build/electron/Backboard IDE.app" \
		"$ROOT/.build/electron/Code - OSS.app"
	do
		if [[ -d "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done
	return 1
}

cmd_doctor() {
	local ok=0
	bold "Backboard Studio dev environment"
	echo

	if bootstrap_path; then
		printf '  \033[32mok\033[0m    node %s (%s)\n' "$(node -v)" "$(command -v node)"
		printf '  \033[32mok\033[0m    npm %s\n' "$(npm -v)"
	else
		printf '  \033[31mmiss\033[0m  node v%s not found\n' "$REQUIRED_NODE"
		printf '        install: https://nodejs.org/dist/v%s/\n' "$REQUIRED_NODE"
		ok=1
	fi

	if have_native_toolchain; then
		printf '  \033[32mok\033[0m    Xcode command line tools (%s)\n' "$(xcode-select -p)"
	else
		printf '  \033[31mmiss\033[0m  Xcode command line tools -- native modules cannot compile\n'
		printf '        fix: xcode-select --install    (needs your admin password)\n'
		ok=1
	fi

	if have_python; then
		printf '  \033[32mok\033[0m    %s (node-gyp)\n' "$(python3 --version 2>&1)"
	else
		printf '  \033[31mmiss\033[0m  python3 -- node-gyp cannot configure native modules\n'
		printf '        fix: comes with the Xcode command line tools\n'
		ok=1
	fi

	if bun_path >/dev/null; then
		printf '  \033[32mok\033[0m    bun %s (%s)\n' "$("$(bun_path)" --version)" "$(bun_path)"
	else
		printf '  \033[31mmiss\033[0m  bun -- agent requests will fail with BackboardSendFailed\n'
		printf '        fix: curl -fsSL https://bun.sh/install | bash\n'
		ok=1
	fi

	if [[ -d "$ROOT/node_modules" && -d "$ROOT/node_modules/@vscode/spdlog/build" ]]; then
		printf '  \033[32mok\033[0m    dependencies installed\n'
	elif [[ -d "$ROOT/node_modules" ]]; then
		printf '  \033[33mpart\033[0m  dependencies installed but native modules did not build\n'
		printf '        fix: ./scripts/dev.sh setup\n'
		ok=1
	else
		printf '  \033[31mmiss\033[0m  dependencies -- run ./scripts/dev.sh setup\n'
		ok=1
	fi

	if app_bundle >/dev/null; then
		printf '  \033[32mok\033[0m    Electron app bundle (%s)\n' "$(basename "$(app_bundle)")"
	else
		printf '  \033[31mmiss\033[0m  Electron app bundle -- run ./scripts/dev.sh setup\n'
		ok=1
	fi

	if launch_output_ready; then
		printf '  \033[32mok\033[0m    out/ is built\n'
	else
		printf '  \033[33mpend\033[0m  out/ not built yet -- the watcher produces it\n'
	fi

	echo
	if [[ "$ok" == 0 ]]; then
		bold "Ready. Run ./scripts/dev.sh to start working."
	else
		bold "Fix the items above, then run ./scripts/dev.sh"
	fi
	return "$ok"
}

require_toolchain() {
	bootstrap_path || fail "Node v$REQUIRED_NODE is required but was not found. Run ./scripts/dev.sh doctor"
	have_native_toolchain || fail "Xcode command line tools are missing. Run: xcode-select --install"
	export_bun_path
}

# --- setup -----------------------------------------------------------------

cmd_setup() {
	require_toolchain
	info "Installing dependencies (this takes a few minutes the first time)"
	npm install
	info "Fetching Electron"
	npm run electron
	info "Setup complete"
}

ensure_setup() {
	require_toolchain
	if [[ ! -d "$ROOT/node_modules" ]]; then
		cmd_setup
		return
	fi
	if ! app_bundle >/dev/null; then
		info "Fetching Electron"
		npm run electron
	fi
}

# --- watcher ---------------------------------------------------------------

launch_output_ready() {
	local file
	for file in "${LAUNCH_FILES[@]}"; do
		[[ -f "$ROOT/$file" ]] || return 1
	done
	return 0
}

watch_running() {
	[[ -f "$WATCH_PID_FILE" ]] && kill -0 "$(cat "$WATCH_PID_FILE")" 2>/dev/null
}

start_watch() {
	if watch_running; then
		info "Watcher already running (pid $(cat "$WATCH_PID_FILE"))"
		return 0
	fi

	mkdir -p "$STATE_DIR"
	: > "$WATCH_LOG"

	info "Starting incremental build watcher"
	# Own process group so `stop` can take down every gulp/tsc child with it.
	setsid_or_bg npm run watch
	echo $! > "$WATCH_PID_FILE"
	info "Watcher pid $(cat "$WATCH_PID_FILE"), log: ${WATCH_LOG#"$ROOT"/}"
}

# macOS has no setsid; a background job in its own subshell is close enough,
# and `kill -PID` on the negated pid still reaches the children.
setsid_or_bg() {
	"$@" >> "$WATCH_LOG" 2>&1 &
}

wait_for_build() {
	local timeout="${1:-1800}"
	local waited=0
	info "Waiting for the first build (up to $((timeout / 60)) min -- later builds are incremental and fast)"

	while (( waited < timeout )); do
		if launch_output_ready && grep -q "Finished transpilation with" "$WATCH_LOG" 2>/dev/null; then
			info "Build ready after ${waited}s"
			return 0
		fi
		if ! watch_running; then
			warn "The watcher exited. Last lines:"
			tail -30 "$WATCH_LOG" >&2
			return 1
		fi
		sleep 2
		waited=$((waited + 2))
		if (( waited % 30 == 0 )); then
			printf '    ... %ss  %s\n' "$waited" "$(tail -1 "$WATCH_LOG" 2>/dev/null | cut -c1-100)"
		fi
	done

	warn "Timed out after ${timeout}s waiting for the build. Check $WATCH_LOG"
	return 1
}

cmd_watch() {
	ensure_setup
	start_watch
	wait_for_build
	info "Watcher is up. Leave it running; it rebuilds on every save."
	info "Follow it with: ./scripts/dev.sh logs"
}

# --- app -------------------------------------------------------------------

app_running() {
	[[ -f "$APP_PID_FILE" ]] && kill -0 "$(cat "$APP_PID_FILE")" 2>/dev/null
}

start_app() {
	mkdir -p "$STATE_DIR"
	info "Launching Backboard Studio"
	# Launching from inside a running VS Code / Backboard extension host inherits that
	# host's environment. ELECTRON_RUN_AS_NODE=1 in particular makes the Electron binary
	# start as plain Node, which fails at `import { Menu } from 'electron'` in out/main.js.
	# The other VSCODE_* vars point the new instance at the host's IPC socket and NLS
	# bundle. Scrub them all so the app starts clean no matter where it was launched from.
	nohup env \
		-u ELECTRON_RUN_AS_NODE \
		-u VSCODE_CWD \
		-u VSCODE_PID \
		-u VSCODE_IPC_HOOK \
		-u VSCODE_NLS_CONFIG \
		-u VSCODE_ESM_ENTRYPOINT \
		-u VSCODE_L10N_BUNDLE_LOCATION \
		-u VSCODE_HANDLES_UNCAUGHT_ERRORS \
		-u VSCODE_CRASH_REPORTER_PROCESS_TYPE \
		"$ROOT/run-backboard-ide.sh" >> "$APP_LOG" 2>&1 &
	echo $! > "$APP_PID_FILE"
	info "App pid $(cat "$APP_PID_FILE"), log: ${APP_LOG#"$ROOT"/}"
}

stop_app() {
	if app_running; then
		kill "$(cat "$APP_PID_FILE")" 2>/dev/null || true
	fi
	# Match whichever bundle name is actually present, not just the Dev one.
	pkill -f "\.build/electron/.*\.app/Contents/MacOS/" 2>/dev/null || true
	rm -f "$APP_PID_FILE"
}

cmd_run() {
	require_toolchain
	launch_output_ready || fail "out/ is not built yet. Run ./scripts/dev.sh watch first."
	stop_app
	start_app
}

# Newest mtime across the main-process output, as an integer.
main_process_stamp() {
	local path newest=0 stamp
	for path in "${MAIN_PROCESS_PATHS[@]}"; do
		[[ -e "$ROOT/$path" ]] || continue
		stamp="$(find "$ROOT/$path" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)"
		if [[ -n "$stamp" ]] && (( stamp > newest )); then newest="$stamp"; fi
	done
	echo "$newest"
}

# Relaunch the app when main-process code is rebuilt. Renderer changes do not
# need this -- Cmd+R picks them up from out/ directly.
supervise() {
	local last
	last="$(main_process_stamp)"
	info "Watching main-process output; the app relaunches when it changes."
	bold "Cmd+R in the window picks up workbench/renderer changes. Ctrl-C here stops the watcher and the app."
	while true; do
		sleep 3
		local now
		now="$(main_process_stamp)"
		if [[ "$now" != "$last" ]]; then
			last="$now"
			info "Main-process code changed -- relaunching"
			stop_app
			sleep 1
			start_app
		fi
		if ! watch_running; then
			warn "Watcher died; see $WATCH_LOG"
			return 1
		fi
	done
}

# --- lifecycle -------------------------------------------------------------

cmd_stop() {
	if watch_running; then
		local pid
		pid="$(cat "$WATCH_PID_FILE")"
		info "Stopping watcher (pid $pid)"
		kill "$pid" 2>/dev/null || true
	fi
	pkill -f "gulp watch-client" 2>/dev/null || true
	pkill -f "build/next/index.ts transpile --watch" 2>/dev/null || true
	rm -f "$WATCH_PID_FILE"
	info "Stopping app"
	stop_app
	info "Stopped"
}

cmd_status() {
	if watch_running; then
		printf '  watcher  \033[32mrunning\033[0m  pid %s\n' "$(cat "$WATCH_PID_FILE")"
	else
		printf '  watcher  \033[31mstopped\033[0m\n'
	fi
	if app_running; then
		printf '  app      \033[32mrunning\033[0m  pid %s\n' "$(cat "$APP_PID_FILE")"
	else
		printf '  app      \033[31mstopped\033[0m\n'
	fi
	if launch_output_ready; then
		printf '  out/     \033[32mbuilt\033[0m\n'
	else
		printf '  out/     \033[33mnot built\033[0m\n'
	fi
}

cmd_logs() {
	[[ -f "$WATCH_LOG" ]] || fail "No watcher log yet. Run ./scripts/dev.sh watch"
	tail -f "$WATCH_LOG"
}

cmd_up() {
	ensure_setup
	start_watch
	wait_for_build || exit 1
	stop_app
	start_app
	trap 'echo; cmd_stop; exit 0' INT TERM
	if [[ "$AUTO_RESTART" == 1 ]]; then
		supervise
	else
		bold "Cmd+R in the window picks up renderer changes. ./scripts/dev.sh stop when you are done."
	fi
}

# --- entrypoint ------------------------------------------------------------

COMMAND="up"
for arg in "$@"; do
	case "$arg" in
		--no-restart) AUTO_RESTART=0 ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) COMMAND="$arg" ;;
	esac
done

case "$COMMAND" in
	up) cmd_up ;;
	doctor) cmd_doctor ;;
	setup) cmd_setup ;;
	watch) cmd_watch ;;
	run) cmd_run ;;
	logs) cmd_logs ;;
	status) cmd_status ;;
	stop) cmd_stop ;;
	*) fail "Unknown command: $COMMAND (try: up, doctor, setup, watch, run, logs, status, stop)" ;;
esac
