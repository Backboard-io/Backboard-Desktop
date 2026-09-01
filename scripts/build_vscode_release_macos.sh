#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_ROOT="${VSCODE_ROOT:-${REPO_ROOT}/backboard}"
if [[ ! -f "${VSCODE_ROOT}/package.json" && -f "${REPO_ROOT}/vscode/package.json" ]]; then
  VSCODE_ROOT="${REPO_ROOT}/vscode"
fi
VERSION="${VERSION:-${1:-}}"
ARCH="${ARCH:-aarch64}"
CHANNEL="${CHANNEL:-stable}"

if [[ -z "${VERSION}" ]]; then
  echo "Missing VERSION. Example: VERSION=2.0.9 $0" >&2
  exit 1
fi

case "${ARCH}" in
  aarch64)
    GULP_TARGET="vscode-darwin-arm64-min"
    VSAPP_DIR="${REPO_ROOT}/VSCode-darwin-arm64"
    CLI_TARGET="bun-darwin-arm64"
    MSAL_VARIANT="macos/arm64"
    NPM_TARGET_ARCH="arm64"
    MACHO_TARGET_ARCH="arm64"
    OPTIONAL_ARCH_PROBES=(
      "node_modules/@vscode/vsce-sign-darwin-arm64/bin/vsce-sign"
      "extensions/copilot/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node"
      "extensions/copilot/node_modules/@anthropic-ai/claude-agent-sdk/vendor/audio-capture/arm64-darwin/audio-capture.node"
      "extensions/copilot/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin/rg"
    )
    ;;
  x86_64)
    GULP_TARGET="vscode-darwin-x64-min"
    VSAPP_DIR="${REPO_ROOT}/VSCode-darwin-x64"
    CLI_TARGET="bun-darwin-x64"
    MSAL_VARIANT="macos/x64"
    NPM_TARGET_ARCH="x64"
    MACHO_TARGET_ARCH="x86_64"
    OPTIONAL_ARCH_PROBES=(
      "node_modules/@vscode/vsce-sign-darwin-x64/bin/vsce-sign"
      "extensions/copilot/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node"
      "extensions/copilot/node_modules/@anthropic-ai/claude-agent-sdk/vendor/audio-capture/x64-darwin/audio-capture.node"
      "extensions/copilot/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-darwin/rg"
    )
    ;;
  *)
    echo "Unsupported ARCH=${ARCH}; expected aarch64 or x86_64" >&2
    exit 1
    ;;
esac

case "${CHANNEL}" in
  stable|sandbox) ;;
  *) echo "Unsupported CHANNEL=${CHANNEL}; expected stable or sandbox" >&2; exit 1 ;;
esac

OUT="${OUT:-${REPO_ROOT}/vscode-release/${VERSION}/${ARCH}}"
RELEASE_LOCK_FILE="${VSCODE_ROOT}/.build/release-build.lock"

cd "${VSCODE_ROOT}"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  set +u
  # shellcheck source=/dev/null
  source "${HOME}/.nvm/nvm.sh"
  nvm use
	set -u
fi

echo "Using node $(node -v)"

mkdir -p "$(dirname "${RELEASE_LOCK_FILE}")"
if [[ -f "${RELEASE_LOCK_FILE}" ]]; then
	existing_release_pid="$(cat "${RELEASE_LOCK_FILE}" 2>/dev/null || true)"
	if [[ -n "${existing_release_pid}" ]] && kill -0 "${existing_release_pid}" 2>/dev/null; then
		echo "Another release build is already running (pid ${existing_release_pid})." >&2
		exit 1
	fi
fi
printf '%s\n' "$$" > "${RELEASE_LOCK_FILE}"
cleanup_release_lock() {
	if [[ "$(cat "${RELEASE_LOCK_FILE}" 2>/dev/null || true)" == "$$" ]]; then
		rm -f "${RELEASE_LOCK_FILE}"
	fi
}
trap cleanup_release_lock EXIT INT TERM

# A development watcher writes to the same `out` and extension output folders
# that the release compiler replaces. Letting both run can produce a bundle
# with files removed halfway through compilation, so always stop the repo's
# tracked development processes before starting a release build.
if [[ -x "${VSCODE_ROOT}/scripts/dev.sh" ]]; then
	echo "Stopping local development watcher before release build"
	"${VSCODE_ROOT}/scripts/dev.sh" stop >/dev/null 2>&1 || true
fi

# VS Code's npm install selects and builds native modules for npm_config_arch.
# Reusing a workspace last installed for the other Mac architecture otherwise
# creates an app whose Electron binary is correct but whose native modules crash
# when loaded. Probe one required runtime module and refresh all dependency
# directories through the repository's normal postinstall when it is stale.
NATIVE_ARCH_PROBE="node_modules/native-keymap/build/Release/keymapping.node"
NATIVE_ARCH_INFO="$(file -b "${NATIVE_ARCH_PROBE}" 2>/dev/null || true)"
REFRESH_NATIVE_DEPENDENCIES=0
if [[ ! -f "${NATIVE_ARCH_PROBE}" || "${NATIVE_ARCH_INFO}" != *"${MACHO_TARGET_ARCH}"* ]]; then
  REFRESH_NATIVE_DEPENDENCIES=1
fi
for probe in "${OPTIONAL_ARCH_PROBES[@]}"; do
  if [[ ! -f "${probe}" || "$(file -b "${probe}" 2>/dev/null || true)" != *"${MACHO_TARGET_ARCH}"* ]]; then
    REFRESH_NATIVE_DEPENDENCIES=1
  fi
done

if [[ "${REFRESH_NATIVE_DEPENDENCIES}" -eq 1 ]]; then
  echo "Refreshing native dependencies for ${ARCH} (npm arch ${NPM_TARGET_ARCH})"
  npm_config_arch="${NPM_TARGET_ARCH}" \
  npm_config_cpu="${NPM_TARGET_ARCH}" \
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  GYP_DEFINES="kerberos_use_rtld=false" \
  npm ci
fi

for probe in "${NATIVE_ARCH_PROBE}" "${OPTIONAL_ARCH_PROBES[@]}"; do
  probe_info="$(file -b "${probe}" 2>/dev/null || true)"
  if [[ ! -f "${probe}" || "${probe_info}" != *"${MACHO_TARGET_ARCH}"* ]]; then
    echo "Native dependency target check failed: ${probe} (${probe_info:-missing})" >&2
    exit 1
  fi
done

# Cross-building also needs a compiler executable for the host. npm's CPU
# filter correctly selects target runtime packages, but that leaves the
# TypeScript native launcher unable to run on the build machine. Install the
# lockfile-pinned host package alongside the target package without changing
# either package.json or package-lock.json.
HOST_NPM_ARCH="$(node -p 'process.arch')"
if [[ "${HOST_NPM_ARCH}" == "arm64" ]]; then
  HOST_MACHO_ARCH="arm64"
else
  HOST_MACHO_ARCH="x86_64"
fi
if [[ "${HOST_NPM_ARCH}" != "${NPM_TARGET_ARCH}" ]]; then
  HOST_TSGO_PACKAGE="@typescript/native-preview-darwin-${HOST_NPM_ARCH}"
  HOST_TSGO_DIR="node_modules/${HOST_TSGO_PACKAGE}"
  HOST_TSGO_BINARY="${HOST_TSGO_DIR}/lib/tsgo"
  if [[ ! -f "${HOST_TSGO_BINARY}" || "$(file -b "${HOST_TSGO_BINARY}" 2>/dev/null || true)" != *"${HOST_MACHO_ARCH}"* ]]; then
    HOST_TSGO_VERSION="$(node -e "const lock=require('./package-lock.json'); const entry=lock.packages['node_modules/${HOST_TSGO_PACKAGE}']; if (!entry?.version) process.exit(1); process.stdout.write(entry.version)")"
    HOST_TSGO_TEMP="$(mktemp -d /tmp/backboard-host-tsgo.XXXXXX)"
    echo "Installing host TypeScript compiler ${HOST_TSGO_PACKAGE}@${HOST_TSGO_VERSION}"
    npm pack "${HOST_TSGO_PACKAGE}@${HOST_TSGO_VERSION}" --pack-destination "${HOST_TSGO_TEMP}" --silent >/dev/null
    mkdir -p "${HOST_TSGO_DIR}"
    tar -xzf "$(find "${HOST_TSGO_TEMP}" -type f -name '*.tgz' -print -quit)" -C "${HOST_TSGO_DIR}" --strip-components=1
    find "${HOST_TSGO_TEMP}" -depth -delete
  fi
  if [[ ! -f "${HOST_TSGO_BINARY}" || "$(file -b "${HOST_TSGO_BINARY}" 2>/dev/null || true)" != *"${HOST_MACHO_ARCH}"* ]]; then
    echo "Host TypeScript compiler check failed: ${HOST_TSGO_BINARY}" >&2
    exit 1
  fi
fi

# Extension bundlers such as microsoft-authentication select their vendored
# native runtime from VSCODE_ARCH rather than from the gulp target name.
export VSCODE_ARCH="${NPM_TARGET_ARCH}"

# The standalone gulp target below compiles the production client into
# out-build/out-vscode. Do not run the development `compile-client` task here:
# it writes to `out`, which is intentionally owned by the local dev watcher.
echo "Preparing Electron and built-in extensions"
npm run electron
node build/lib/builtInExtensions.ts

echo "Compiling Backboard extension"
npm --prefix extensions/backboard run compile

echo "Testing Backboard updater release safeguards"
npm --prefix extensions/backboard run test-updater

echo "Compiling Backboard CLI runtime"
# Without an explicit target bun compiles for the host, which puts an arm64 CLI
# inside an Intel release when cross-building on Apple Silicon.
BACKBOARD_CLI_TARGET="${CLI_TARGET}" npm --prefix extensions/backboard run package-cli-ts

# @azure/msal-node-runtime ships every platform's binaries and copies the host's
# up to dist/ at install time, so a cross-build inherits the wrong one. Promote
# the variant matching the target architecture before the app is assembled.
MSAL_RUNTIME_DIR="extensions/microsoft-authentication/node_modules/@azure/msal-node-runtime/dist"
if [[ -d "${MSAL_RUNTIME_DIR}/${MSAL_VARIANT}" ]]; then
  echo "Promoting MSAL runtime for ${ARCH}"
  cp "${MSAL_RUNTIME_DIR}/${MSAL_VARIANT}/libmsalruntime.dylib" "${MSAL_RUNTIME_DIR}/libmsalruntime.dylib"
  cp "${MSAL_RUNTIME_DIR}/${MSAL_VARIANT}/msal-node-runtime.node" "${MSAL_RUNTIME_DIR}/msal-node-runtime.node"
else
  echo "No MSAL runtime variant at ${MSAL_RUNTIME_DIR}/${MSAL_VARIANT}; keeping install-time copy" >&2
fi

echo "Building standalone ${GULP_TARGET} app"
BACKBOARD_KEEP_COPILOT_SHIM_MARKER=1 npm run gulp -- "${GULP_TARGET}"

if [[ -d "${VSAPP_DIR}/Backboard IDE.app" ]]; then
  VSAPP="${VSAPP_DIR}/Backboard IDE.app"
elif [[ -d "${VSAPP_DIR}/Backboard Studio.app" ]]; then
  VSAPP="${VSAPP_DIR}/Backboard Studio.app"
elif [[ -d "${VSAPP_DIR}/Backboard Studio Dev.app" ]]; then
  VSAPP="${VSAPP_DIR}/Backboard Studio Dev.app"
else
  echo "Missing packaged app in ${VSAPP_DIR}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

if [[ "${SKIP_SIGNING:-0}" == "1" ]]; then
  echo "Packaging Backboard Studio ${VERSION} (${ARCH}, ${CHANNEL}) without signing or notarization"
elif [[ "${SKIP_NOTARIZATION:-0}" == "1" ]]; then
  echo "Packaging Backboard Studio ${VERSION} (${ARCH}, ${CHANNEL}) without notarization"
else
  echo "Packaging and notarizing Backboard Studio ${VERSION} (${ARCH}, ${CHANNEL})"
fi
SKIP_BACKBOARD_REBUILD=1 \
VERSION="${VERSION}" \
ARCH="${ARCH}" \
CHANNEL="${CHANNEL}" \
SKIP_NOTARIZATION="${SKIP_NOTARIZATION:-0}" \
SKIP_SIGNING="${SKIP_SIGNING:-0}" \
VSAPP="${VSAPP}" \
OUT="${OUT}" \
"${REPO_ROOT}/scripts/package_vscode_update_macos.sh"

DMG_PATH="${OUT}/Backboard-Studio-${ARCH}.dmg"
echo "Built DMG: ${DMG_PATH}"

if [[ "${SKIP_SIGNING:-0}" == "1" || "${SKIP_NOTARIZATION:-0}" == "1" ]]; then
  echo "Skipping release-readiness validation because signing or notarization was disabled."
else
  VALIDATION_ARGS=(
    --version "${VERSION}"
    --arch "${ARCH}"
    --channel "${CHANNEL}"
    --dmg "${DMG_PATH}"
  )
  if [[ -n "${EXPECTED_TEAM_ID:-}" ]]; then
    VALIDATION_ARGS+=(--expected-team-id "${EXPECTED_TEAM_ID}")
  fi
  "${REPO_ROOT}/scripts/validate_macos_release.sh" "${VALIDATION_ARGS[@]}"
fi

echo
echo "Release size report:"
du -sh "${VSAPP}" "${OUT}/dmg" "${DMG_PATH}"
INSTALLED_APP="$(find "${OUT}/dmg" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -n "${INSTALLED_APP}" ]]; then
  SOURCE_APP_KB="$(du -sk "${VSAPP}" | awk '{ print $1 }')"
  INSTALLED_APP_KB="$(du -sk "${INSTALLED_APP}" | awk '{ print $1 }')"
  awk -v source="${SOURCE_APP_KB}" -v installed="${INSTALLED_APP_KB}" '
    BEGIN {
      reduction = source > 0 ? (source - installed) * 100 / source : 0
      printf "Installed app: %.1f MiB (%.1f%% smaller than the assembled app)\n", installed / 1024, reduction
    }
  '
fi
echo "DMG bytes: $(stat -f%z "${DMG_PATH}")"
