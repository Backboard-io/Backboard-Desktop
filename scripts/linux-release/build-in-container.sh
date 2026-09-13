#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT="/work/source"
VSCODE_ROOT="${SOURCE_ROOT}/backboard"
OUTPUT_ROOT="/work/output"
VERSION="${VERSION:?VERSION is required}"
ARCH="${ARCH:-x86_64}"
CHANNEL="${CHANNEL:-stable}"
SOURCE_COMMIT="${BUILD_SOURCEVERSION:?BUILD_SOURCEVERSION is required}"
SOURCE_DIRTY_SHA256="${SOURCE_DIRTY_SHA256:?SOURCE_DIRTY_SHA256 is required}"
BUILT_AT="${BUILT_AT:?BUILT_AT is required}"

if [[ "$(uname -m)" != "x86_64" || "${ARCH}" != "x86_64" ]]; then
	echo "This release builder requires an x86_64 Linux environment." >&2
	exit 1
fi
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
	echo "Invalid VERSION=${VERSION}" >&2
	exit 1
fi
case "${CHANNEL}" in
	stable|sandbox) ;;
	*) echo "Unsupported CHANNEL=${CHANNEL}" >&2; exit 1 ;;
esac

export BACKBOARD_CLI_TARGET="bun-linux-x64"
export BUILD_SOURCEVERSION="${SOURCE_COMMIT}"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export GYP_DEFINES="kerberos_use_rtld=false"
export VSCODE_ARCH="x64"
export npm_config_arch="x64"
export npm_config_cpu="x64"
export npm_config_jobs="${BUILD_JOBS:-6}"

echo "Building Backboard Studio ${VERSION} (${CHANNEL}, Linux x86_64)"
echo "Environment: $(node --version), npm $(npm --version), bun $(bun --version)"
mkdir -p "${OUTPUT_ROOT}"
cd "${VSCODE_ROOT}"

echo "Installing lockfile-pinned dependencies"
npm ci

echo "Preparing generated development files"
node build/lib/preLaunch.ts

# Compilation checks are deliberately before tests. A successful test run is
# not a release signal when the current TypeScript tree does not type-check.
echo "Type-checking the VS Code client"
npm run typecheck-client

echo "Type-checking and compiling the Backboard extension"
npm --prefix extensions/backboard run typecheck
npm --prefix extensions/backboard run compile

echo "Testing updater installation safeguards"
npm --prefix extensions/backboard run test-updater

echo "Building the Linux x86_64 Backboard CLI"
npm --prefix extensions/backboard run package-cli-ts
CLI_SOURCE="${VSCODE_ROOT}/extensions/backboard/bin/backboard-cli-ts"
CLI_SOURCE_INFO="$(file -b "${CLI_SOURCE}")"
if [[ "${CLI_SOURCE_INFO}" != *ELF* || "${CLI_SOURCE_INFO}" != *x86-64* ]]; then
	echo "Backboard CLI has the wrong architecture: ${CLI_SOURCE_INFO}" >&2
	exit 1
fi

# npm normally promotes the correct host variant. Copying it explicitly keeps
# this invariant visible and prevents a future install-script change from
# silently putting a macOS or ARM native module in the Linux release.
MSAL_RUNTIME_DIR="extensions/microsoft-authentication/node_modules/@azure/msal-node-runtime/dist"
MSAL_VARIANT_DIR="${MSAL_RUNTIME_DIR}/linux/x64"
if [[ -d "${MSAL_VARIANT_DIR}" ]]; then
	cp "${MSAL_VARIANT_DIR}/libmsalruntime.so" "${MSAL_RUNTIME_DIR}/libmsalruntime.so"
	cp "${MSAL_VARIANT_DIR}/msal-node-runtime.node" "${MSAL_RUNTIME_DIR}/msal-node-runtime.node"
fi

echo "Stamping stable Linux branding in the isolated source copy"
node "${SOURCE_ROOT}/scripts/linux-release/stamp-product.mjs" \
	--product "${VSCODE_ROOT}/product.json" \
	--package "${VSCODE_ROOT}/package.json" \
	--version "${VERSION}" \
	--arch "${ARCH}" \
	--channel "${CHANNEL}" \
	--built-at "${BUILT_AT}" \
	--source-commit "${SOURCE_COMMIT}" \
	--source-dirty-sha256 "${SOURCE_DIRTY_SHA256}"

echo "Compiling and assembling the standalone Linux application"
BACKBOARD_KEEP_COPILOT_SHIM_MARKER=1 npm run gulp -- vscode-linux-x64

APP_NAME="backboard-studio"
if [[ "${CHANNEL}" == "sandbox" ]]; then
	APP_NAME="backboard-studio-sandbox"
fi
APP_DIR="${SOURCE_ROOT}/VSCode-linux-x64"
APP_RESOURCES="${APP_DIR}/resources/app"
APP_BINARY="${APP_DIR}/${APP_NAME}"
BACKBOARD_SOURCE="${VSCODE_ROOT}/extensions/backboard"
BACKBOARD_PACKAGED="${APP_RESOURCES}/extensions/backboard"

for required_path in \
	"${APP_BINARY}" \
	"${APP_RESOURCES}/package.json" \
	"${APP_RESOURCES}/product.json" \
	"${BACKBOARD_SOURCE}/package.json" \
	"${BACKBOARD_SOURCE}/out/extension.js" \
	"${BACKBOARD_SOURCE}/media" \
	"${BACKBOARD_SOURCE}/bin/backboard-cli-ts" \
	"${BACKBOARD_PACKAGED}"; do
	if [[ ! -e "${required_path}" ]]; then
		echo "Missing required packaged path: ${required_path}" >&2
		exit 1
	fi
done

echo "Syncing the tested Backboard extension runtime into the packaged app"
rm -rf \
	"${BACKBOARD_PACKAGED}/out" \
	"${BACKBOARD_PACKAGED}/media" \
	"${BACKBOARD_PACKAGED}/bin"
cp "${BACKBOARD_SOURCE}/package.json" "${BACKBOARD_PACKAGED}/package.json"
cp -a "${BACKBOARD_SOURCE}/out" "${BACKBOARD_PACKAGED}/out"
cp -a "${BACKBOARD_SOURCE}/media" "${BACKBOARD_PACKAGED}/media"
mkdir -p "${BACKBOARD_PACKAGED}/bin"
install -m 0755 "${BACKBOARD_SOURCE}/bin/backboard-cli-ts" "${BACKBOARD_PACKAGED}/bin/backboard-cli-ts"

node "${SOURCE_ROOT}/scripts/linux-release/stamp-product.mjs" \
	--product "${APP_RESOURCES}/product.json" \
	--package "${APP_RESOURCES}/package.json" \
	--build-info "${APP_RESOURCES}/backboard-build-info.json" \
	--version "${VERSION}" \
	--arch "${ARCH}" \
	--channel "${CHANNEL}" \
	--built-at "${BUILT_AT}" \
	--source-commit "${SOURCE_COMMIT}" \
	--source-dirty-sha256 "${SOURCE_DIRTY_SHA256}"

echo "Checking packaged native-code architecture"
MAIN_INFO="$(file -b "${APP_BINARY}")"
PACKAGED_CLI="${BACKBOARD_PACKAGED}/bin/backboard-cli-ts"
PACKAGED_CLI_INFO="$(file -b "${PACKAGED_CLI}")"
if [[ "${MAIN_INFO}" != *ELF* || "${MAIN_INFO}" != *x86-64* ]]; then
	echo "Application binary has the wrong architecture: ${MAIN_INFO}" >&2
	exit 1
fi
if [[ "${PACKAGED_CLI_INFO}" != *ELF* || "${PACKAGED_CLI_INFO}" != *x86-64* ]]; then
	echo "Packaged CLI has the wrong architecture: ${PACKAGED_CLI_INFO}" >&2
	exit 1
fi

NATIVE_REPORT="$(mktemp /tmp/backboard-native-files.XXXXXX)"
find "${APP_DIR}" -type f \
	\( -perm /111 -o -name '*.node' -o -name '*.so' -o -name '*.so.*' \) \
	-print0 | xargs -0 file > "${NATIVE_REPORT}"
architecture_failures=0
while IFS= read -r report_line; do
	native_path="${report_line%%:*}"
	native_info="${report_line#*: }"
	case "${native_info}" in
		*ELF*)
			case "${native_info}" in
				*x86-64*) ;;
				*)
					case "${native_path}" in
						*/arm64/*|*/aarch64/*|*/armhf/*|*/armv7*/*|*/linux-arm64/*|*/linux-armhf/*|*/x86/*|*/ia32/*) ;;
						*) echo "Unexpected non-x86_64 ELF: ${report_line}" >&2; architecture_failures=$((architecture_failures + 1)) ;;
					esac
			esac
			;;
		*Mach-O*)
			case "${native_path}" in
				*/darwin-*/*|*/macos/*|*/darwin/*) ;;
				*) echo "Unexpected macOS binary: ${report_line}" >&2; architecture_failures=$((architecture_failures + 1)) ;;
			esac
			;;
		*PE32*)
			case "${native_path}" in
				*/win32-*/*|*/windows/*|*/win32/*) ;;
				*) echo "Unexpected Windows binary: ${report_line}" >&2; architecture_failures=$((architecture_failures + 1)) ;;
			esac
			;;
	esac
done < "${NATIVE_REPORT}"
rm -f "${NATIVE_REPORT}"
if (( architecture_failures > 0 )); then
	echo "Native architecture validation found ${architecture_failures} problem(s)." >&2
	exit 1
fi

if ldd "${APP_BINARY}" | grep -F 'not found'; then
	echo "The application has unresolved shared-library dependencies." >&2
	exit 1
fi

echo "Checking command-line startup"
VERSION_OUTPUT="$(${APP_BINARY} --no-sandbox --version)"
printf '%s\n' "${VERSION_OUTPUT}"
if [[ "${VERSION_OUTPUT}" != *x64* ]]; then
	echo "The application did not report an x64 build." >&2
	exit 1
fi

echo "Running a headless GUI launch smoke test"
SMOKE_ROOT="$(mktemp -d /tmp/backboard-smoke.XXXXXX)"
SMOKE_LOG="${SMOKE_ROOT}/launch.log"
set +e
xvfb-run -a timeout --signal=TERM --kill-after=5s 25s \
	"${APP_BINARY}" \
	--no-sandbox \
	--disable-gpu \
	--disable-dev-shm-usage \
	--skip-welcome \
	--user-data-dir="${SMOKE_ROOT}/user-data" \
	--extensions-dir="${SMOKE_ROOT}/extensions" \
	--new-window "${SMOKE_ROOT}" >"${SMOKE_LOG}" 2>&1
smoke_status=$?
set -e
if [[ "${smoke_status}" -ne 0 && "${smoke_status}" -ne 124 ]]; then
	cat "${SMOKE_LOG}" >&2
	echo "Headless launch exited unexpectedly with status ${smoke_status}." >&2
	exit 1
fi
if grep -Eiq 'segmentation fault|trace/breakpoint trap|core dumped|fatal error' "${SMOKE_LOG}"; then
	cat "${SMOKE_LOG}" >&2
	echo "Headless launch log contains a fatal error." >&2
	exit 1
fi
rm -rf "${SMOKE_ROOT}"

echo "Preparing the Debian package"
npm run gulp -- vscode-linux-x64-prepare-deb
DEB_STAGE="${VSCODE_ROOT}/.build/linux/deb/amd64/${APP_NAME}-amd64"
DEB_CONTROL="${DEB_STAGE}/DEBIAN/control"
if [[ ! -f "${DEB_CONTROL}" ]]; then
	echo "Debian control file was not generated: ${DEB_CONTROL}" >&2
	exit 1
fi
sed -i -E "s/^Version:.*/Version: ${VERSION}/" "${DEB_CONTROL}"
npm run gulp -- vscode-linux-x64-build-deb
DEB_SOURCE="$(find "${VSCODE_ROOT}/.build/linux/deb/amd64/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)"
if [[ -z "${DEB_SOURCE}" ]]; then
	echo "The Debian package task did not create a .deb file." >&2
	exit 1
fi

TARBALL_NAME="Backboard-Studio-linux-x86_64.tar.gz"
DEB_NAME="Backboard-Studio-linux-x86_64.deb"
TARBALL_ROOT="Backboard-Studio-linux-x86_64"
tar -C "${SOURCE_ROOT}" \
	--transform "s|^VSCode-linux-x64|${TARBALL_ROOT}|" \
	-czf "${OUTPUT_ROOT}/${TARBALL_NAME}" \
	VSCode-linux-x64
cp "${DEB_SOURCE}" "${OUTPUT_ROOT}/${DEB_NAME}"

echo "Validating final Debian metadata and payload"
test "$(dpkg-deb --field "${OUTPUT_ROOT}/${DEB_NAME}" Version)" = "${VERSION}"
test "$(dpkg-deb --field "${OUTPUT_ROOT}/${DEB_NAME}" Architecture)" = "amd64"
dpkg-deb --contents "${OUTPUT_ROOT}/${DEB_NAME}" | grep -F "./usr/share/${APP_NAME}/${APP_NAME}" >/dev/null

EXTRACT_ROOT="$(mktemp -d /tmp/backboard-deb.XXXXXX)"
dpkg-deb --extract "${OUTPUT_ROOT}/${DEB_NAME}" "${EXTRACT_ROOT}"
EXTRACTED_BINARY="${EXTRACT_ROOT}/usr/share/${APP_NAME}/${APP_NAME}"
EXTRACTED_INFO="$(file -b "${EXTRACTED_BINARY}")"
if [[ "${EXTRACTED_INFO}" != *ELF* || "${EXTRACTED_INFO}" != *x86-64* ]]; then
	echo "Debian application binary has the wrong architecture: ${EXTRACTED_INFO}" >&2
	exit 1
fi
rm -rf "${EXTRACT_ROOT}"

cd "${OUTPUT_ROOT}"
sha256sum "${TARBALL_NAME}" "${DEB_NAME}" > SHA256SUMS

echo "Linux release artifacts are ready"
du -h "${OUTPUT_ROOT}/${TARBALL_NAME}" "${OUTPUT_ROOT}/${DEB_NAME}"
cat SHA256SUMS

