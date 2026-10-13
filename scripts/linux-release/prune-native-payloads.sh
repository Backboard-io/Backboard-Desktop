#!/usr/bin/env bash
set -euo pipefail

APP_RESOURCES="${1:?Packaged resources/app directory is required}"
if [[ "${APP_RESOURCES}" != */resources/app || ! -f "${APP_RESOURCES}/product.json" ]]; then
	echo "Expected a packaged resources/app directory with product.json." >&2
	exit 1
fi

# Backboard uses its own chat stack and compiled agent CLI, as in the macOS
# release. The legacy Copilot extension and its SDK are not runtime inputs.
rm -rf "${APP_RESOURCES}/extensions/copilot" \
	"${APP_RESOURCES}/node_modules/@github/copilot" \
	"${APP_RESOURCES}/node_modules/@github/copilot-sdk"

# Only platform-qualified native payload directories are removed. Generic
# resource names such as linux, windows, x64, and arm64 remain untouched.
while IFS= read -r -d '' payload; do
	rm -rf "${payload}"
done < <(find "${APP_RESOURCES}" -type d \( \
	-name 'darwin-*' -o -name '*-darwin-*' -o \
	-name 'x64-darwin' -o -name 'arm64-darwin' -o \
	-name 'win32-*' -o -name '*-win32-*' -o \
	-name 'x64-win32' -o -name 'arm64-win32' -o \
	-name 'linux-arm64' -o -name 'linux-armhf' -o -name 'linux-arm' -o \
	-name '*-linux-arm64' -o -name '*-linux-armhf' -o -name '*-linux-arm' -o \
	-name 'arm64-linux' -o -name 'arm-linux' \
\) -prune -print0)

# The built-in JS debugger bundles Windows AppContainer helpers directly in
# src/, with the platform in the filename instead of a containing directory.
JS_DEBUG_SRC="${APP_RESOURCES}/extensions/ms-vscode.js-debug/src"
if [[ -d "${JS_DEBUG_SRC}" ]]; then
	find "${JS_DEBUG_SRC}" -type f -name 'win32-app-container-tokens.win32-*.node' -delete
fi

# The build already promotes the selected Linux MSAL pair into dist/.
MSAL_DIST="${APP_RESOURCES}/extensions/microsoft-authentication/node_modules/@azure/msal-node-runtime/dist"
rm -rf "${MSAL_DIST}/macos" "${MSAL_DIST}/win32" "${MSAL_DIST}/linux"

# MXC puts several operating systems in bin/x64 rather than qualifying the
# directory by platform. Keep the Linux sandbox/proxy and target architecture.
MXC_BIN="${APP_RESOURCES}/node_modules/@microsoft/mxc-sdk/bin"
if [[ -d "${MXC_BIN}" ]]; then
	rm -rf "${MXC_BIN}/arm64"
	find "${MXC_BIN}" -type f \( -name '*.exe' -o -name '*.dll' -o -name 'mxc-exec-mac' \) -delete
fi
