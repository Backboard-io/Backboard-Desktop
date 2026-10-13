#!/usr/bin/env bash
# Builds the vendored Cua Driver (backboard/cua-driver, MIT) and installs it
# beside the cli-ts runtime, where both dev and packaged builds look for it.
#
# The driver executes Jev computer-use tasks. It is optional: without it cli-ts
# falls back to its built-in platform layer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/extensions/backboard/bin"

if ! command -v cargo >/dev/null 2>&1; then
	echo "cargo was not found. Install Rust (https://rustup.rs) and re-run." >&2
	exit 1
fi

# The driver reports usage to its authors unless told not to, including from
# build scripts. Backboard never enables it; cli-ts also disables it at runtime.
export CUA_DRIVER_RS_TELEMETRY_ENABLED=false
export CUA_TELEMETRY_ENABLED=false

(cd "$ROOT/cua-driver/rust" && cargo build --release --locked -p cua-driver)

EXE="cua-driver"
case "$(uname -s)" in
	MINGW* | MSYS* | CYGWIN*) EXE="cua-driver.exe" ;;
esac

mkdir -p "$BIN_DIR"
cp "$ROOT/cua-driver/rust/target/release/$EXE" "$BIN_DIR/$EXE"
echo "Installed $BIN_DIR/$EXE ($("$BIN_DIR/$EXE" --version))"
