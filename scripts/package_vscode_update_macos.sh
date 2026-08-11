#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_ROOT="${REPO_ROOT}/vscode"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  CURRENT_DIR="${PWD}"
  cd "${VSCODE_ROOT}"
  set +u
  # shellcheck source=/dev/null
  source "${HOME}/.nvm/nvm.sh"
  nvm use
  set -u
  cd "${CURRENT_DIR}"
fi

VERSION="${VERSION:-}"
ARCH="${ARCH:-aarch64}"
CHANNEL="${CHANNEL:-stable}"
if [[ "${ARCH}" == "x86_64" ]]; then
  DEFAULT_VSAPP="${REPO_ROOT}/VSCode-darwin-x64/Backboard Studio.app"
else
  DEFAULT_VSAPP="${REPO_ROOT}/VSCode-darwin-arm64/Backboard Studio.app"
fi
VSAPP="${VSAPP:-${DEFAULT_VSAPP}}"
OUT="${OUT:-${REPO_ROOT}/vscode-release/${VERSION:-unversioned}/${ARCH}}"
DMG_NAME="Backboard-Studio-${ARCH}.dmg"
DMG_PATH="${OUT}/${DMG_NAME}"
DMG_FORMAT="${DMG_FORMAT:-ULMO}"
DMG_ASSETS_DIR="${DMG_ASSETS_DIR:-${REPO_ROOT}/scripts/dmg-assets}"
P12_PATH="${P12_PATH:-${HOME}/.backboard/apple-notarization/developer-id-application.p12}"
P12_PASSWORD_PATH="${P12_PASSWORD_PATH:-${HOME}/.backboard/apple-notarization/p12-password.txt}"
ASC_KEY_PATH="${ASC_KEY_PATH:-${HOME}/.backboard/apple-notarization/AuthKey_394Z48F5U4.p8}"
SKIP_NOTARIZATION="${SKIP_NOTARIZATION:-0}"
SKIP_SIGNING="${SKIP_SIGNING:-0}"
APPLE_NOTARIZATION_KEY_ID="${APPLE_NOTARIZATION_KEY_ID:-394Z48F5U4}"
APPLE_NOTARIZATION_ISSUER_ID="${APPLE_NOTARIZATION_ISSUER_ID:-8ff632f9-6430-4bcf-aa2b-115b23c1150e}"
KEYCHAIN_NAME="${KEYCHAIN_NAME:-backboard-vscode-signing.keychain}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-${HOME}/Library/Keychains/${KEYCHAIN_NAME}-db}"
IDENTITY="${IDENTITY:-}"

if [[ -z "${VERSION}" ]]; then
  echo "Missing VERSION. Example: VERSION=1.3.10 $0" >&2
  exit 1
fi

case "${ARCH}" in
  aarch64|x86_64) ;;
  *) echo "Unsupported ARCH=${ARCH}; expected aarch64 or x86_64" >&2; exit 1 ;;
esac

case "${CHANNEL}" in
  stable|sandbox) ;;
  *) echo "Unsupported CHANNEL=${CHANNEL}; expected stable or sandbox" >&2; exit 1 ;;
esac

if [[ "${CHANNEL}" == "sandbox" ]]; then
  APP_DISPLAY_NAME="Backboard Studio Sandbox"
  BUNDLE_IDENTIFIER="io.backboard.studio.sandbox"
else
  APP_DISPLAY_NAME="Backboard Studio"
  BUNDLE_IDENTIFIER="io.backboard.studio"
fi

APP_NAME="${APP_DISPLAY_NAME}.app"
APP_PATH="${OUT}/dmg/${APP_NAME}"
DMG_VOLUME_NAME="${APP_DISPLAY_NAME}"

require_file() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    echo "Missing required file: ${path}" >&2
    exit 1
  fi
}

preflight_disk_space() {
  local source_kb
  local existing_out_kb=0
  local available_kb
  local effective_available_kb
  local required_kb

  source_kb="$(du -sk "${VSAPP}" | awk '{ print $1 }')"
  if [[ -e "${OUT}" ]]; then
    existing_out_kb="$(du -sk "${OUT}" | awk '{ print $1 }')"
  fi
  available_kb="$(df -Pk "${REPO_ROOT}" | awk 'NR == 2 { print $4 }')"
  effective_available_kb=$((available_kb + existing_out_kb))

  # Packaging temporarily needs the copied app, an uncompressed hybrid image,
  # and the final compressed DMG at the same time. Keep an additional GiB free
  # so hdiutil and codesign do not fail midway through a release.
  required_kb=$((source_kb * 2 + 1048576))
  if (( effective_available_kb < required_kb )); then
    awk -v available="${effective_available_kb}" -v required="${required_kb}" '
      BEGIN {
        printf "Insufficient disk space for packaging: %.1f GiB available after replacing OUT; %.1f GiB required.\n", available / 1048576, required / 1048576 > "/dev/stderr"
      }
    '
    exit 1
  fi

  awk -v available="${effective_available_kb}" -v required="${required_kb}" '
    BEGIN {
      printf "Disk-space preflight passed: %.1f GiB available after replacing OUT; %.1f GiB required.\n", available / 1048576, required / 1048576
    }
  '
}

set_plist_string() {
  local plist="$1"
  local key="$2"
  local value="$3"
  /usr/libexec/PlistBuddy -c "Set :${key} ${value}" "${plist}" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "${plist}"
}

write_release_metadata() {
  local app_resources_path="${APP_PATH}/Contents/Resources/app"
  local package_json="${app_resources_path}/package.json"
  local product_json="${app_resources_path}/product.json"
  local build_info_json="${app_resources_path}/backboard-build-info.json"
  local built_at
  local source_commit
  local source_dirty_sha256

  built_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  source_commit="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo "unknown")"
  source_dirty_sha256="$(
    {
      git -C "${REPO_ROOT}" diff --binary HEAD -- vscode scripts 2>/dev/null || true
      git -C "${REPO_ROOT}" ls-files --others --exclude-standard vscode scripts 2>/dev/null \
        | while IFS= read -r path; do
          printf 'untracked %s\n' "${path}"
          shasum -a 256 "${REPO_ROOT}/${path}" 2>/dev/null || true
        done
    } | shasum -a 256 | awk '{ print $1 }'
  )"

  node - "${package_json}" "${product_json}" "${build_info_json}" "${VERSION}" "${ARCH}" "${CHANNEL}" "${built_at}" "${source_commit}" "${source_dirty_sha256}" "${VSAPP}" "${APP_DISPLAY_NAME}" "${BUNDLE_IDENTIFIER}" <<'NODE'
const fs = require('fs');
const [
  packageJsonPath,
  productJsonPath,
  buildInfoJsonPath,
  version,
  arch,
  channel,
  builtAt,
  sourceCommit,
  sourceDirtySha256,
  sourceApp,
  appDisplayName,
  bundleIdentifier,
] = process.argv.slice(2);

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// The VS Code engine version (what `vscode.version` returns and what extension
// `engines.vscode` ranges are validated against) MUST stay on the 1.x line baked
// in by the gulp build. Overwriting it with the 2.x product `version` makes every
// extension that declares a `^1.x` engine (built-in language servers AND anything
// installed from the marketplace, e.g. anthropic.claude-code) fail to install and
// activate. Leave package.json/product.json `version` untouched and route the
// release version to `backboardVersion` (product branding) instead.
const packageJson = readJson(packageJsonPath);
const engineVersion = packageJson.version;

// Fail the build loudly if the engine version was ever bumped to 2.x. Shipping a
// 2.x `vscode.version` silently disables every `^1.x` extension, which is exactly
// the failure this split is meant to prevent.
const engineMajor = Number(String(engineVersion).split('.')[0]);
if (engineMajor !== 1) {
  throw new Error(
    `VS Code engine version must stay on the 1.x line for extension compatibility, ` +
    `but vscode/package.json version is "${engineVersion}". Restore it to 1.x. ` +
    `The product/release version "${version}" is recorded separately as backboardVersion.`
  );
}

const productJson = readJson(productJsonPath);
productJson.version = engineVersion;
productJson.nameShort = appDisplayName;
productJson.nameLong = appDisplayName;
productJson.darwinBundleIdentifier = bundleIdentifier;
productJson.backboardVersion = version;
productJson.backboardStudioVersion = version;
productJson.backboardUpdateChannel = channel;
productJson.date = builtAt;
productJson.backboardBuildInfo = {
  version,
  engineVersion,
  arch,
  channel,
  builtAt,
  sourceCommit,
  sourceDirtySha256,
  sourceApp,
};
writeJson(productJsonPath, productJson);

writeJson(buildInfoJsonPath, {
  version,
  engineVersion,
  arch,
  channel,
  builtAt,
  sourceCommit,
  sourceDirtySha256,
  sourceApp,
  appDisplayName,
  bundleIdentifier,
  packageJsonVersion: packageJson.version,
  productJsonNameShort: productJson.nameShort,
  productJsonNameLong: productJson.nameLong,
  productJsonDarwinBundleIdentifier: productJson.darwinBundleIdentifier,
  productJsonVersion: productJson.version,
  productJsonBackboardVersion: productJson.backboardVersion,
  productJsonBackboardStudioVersion: productJson.backboardStudioVersion,
  productJsonBackboardUpdateChannel: productJson.backboardUpdateChannel,
});
NODE
}

require_file "${VSAPP}"
require_file "${VSAPP}/Contents/Info.plist"
require_file "${VSAPP}/Contents/Resources/app"
if [[ "${SKIP_SIGNING}" != "1" ]]; then
  require_file "${P12_PATH}"
fi
if [[ "${SKIP_SIGNING}" != "1" && "${SKIP_NOTARIZATION}" != "1" ]]; then
  require_file "${ASC_KEY_PATH}"
fi
if [[ "${SKIP_SIGNING}" != "1" ]]; then
  require_file "${REPO_ROOT}/vscode/build/azure-pipelines/darwin/app-entitlements.plist"
fi
preflight_disk_space

BACKBOARD_EXTENSION_SOURCE="${VSCODE_ROOT}/extensions/backboard"
BACKBOARD_CLI_SOURCE="${BACKBOARD_EXTENSION_SOURCE}/bin/backboard-cli-ts"

rebuild_backboard_runtime() {
  if [[ "${SKIP_BACKBOARD_REBUILD:-0}" == "1" ]]; then
    return
  fi

  echo "Rebuilding Backboard extension and CLI runtime"
  (cd "${VSCODE_ROOT}" && npm --prefix extensions/backboard run compile)
  # bun compiles for the host unless told otherwise, which puts an arm64 CLI in
  # an Intel release when cross-building on Apple Silicon.
  local cli_target
  case "${ARCH}" in
    aarch64) cli_target="bun-darwin-arm64" ;;
    x86_64) cli_target="bun-darwin-x64" ;;
    *) cli_target="" ;;
  esac
  (cd "${BACKBOARD_EXTENSION_SOURCE}" && BACKBOARD_CLI_TARGET="${cli_target}" npm run package-cli-ts)
}

sync_backboard_extension_runtime() {
  echo "Syncing Backboard extension runtime files"
  require_file "${BACKBOARD_EXTENSION_SOURCE}/package.json"
  require_file "${BACKBOARD_EXTENSION_SOURCE}/out/extension.js"
  require_file "${BACKBOARD_EXTENSION_SOURCE}/media"
  require_file "${BACKBOARD_CLI_SOURCE}"

  rm -rf \
    "${BACKBOARD_EXTENSION_PATH}/out" \
    "${BACKBOARD_EXTENSION_PATH}/media" \
    "${BACKBOARD_EXTENSION_PATH}/bin"

  cp "${BACKBOARD_EXTENSION_SOURCE}/package.json" "${BACKBOARD_EXTENSION_PATH}/package.json"
  cp -R "${BACKBOARD_EXTENSION_SOURCE}/out" "${BACKBOARD_EXTENSION_PATH}/out"
  cp -R "${BACKBOARD_EXTENSION_SOURCE}/media" "${BACKBOARD_EXTENSION_PATH}/media"
  mkdir -p "${BACKBOARD_EXTENSION_PATH}/bin"
  cp "${BACKBOARD_CLI_SOURCE}" "${BACKBOARD_EXTENSION_PATH}/bin/backboard-cli-ts"
  chmod 755 "${BACKBOARD_EXTENSION_PATH}/bin/backboard-cli-ts"
}

prune_release_app() {
  if [[ "${SKIP_RELEASE_PRUNE:-0}" == "1" ]]; then
    echo "Skipping release pruning because SKIP_RELEASE_PRUNE=1"
    return
  fi

  local app_resources_path="${APP_PATH}/Contents/Resources/app"
  local before_kb
  local after_kb
  before_kb="$(du -sk "${APP_PATH}" | awk '{ print $1 }')"

  echo "Pruning production-only release bloat"

  # Source maps are useful for debugging, but they are not required for runtime
  # chat, Copilot contributions, Backboard agent-host, or the right-side AI UI.
  find "${app_resources_path}" -type f \( -name "*.map" -o -name "*.d.ts.map" \) -delete
  find "${app_resources_path}" -type f -name "*.tsbuildinfo" -delete

  # The Backboard extension only needs package.json, out/, media/, and bin/ in
  # production. Keep Copilot installed; this only removes Backboard source/build
  # leftovers if the upstream VS Code packaging copied them.
  rm -rf \
    "${app_resources_path}/extensions/backboard/rust" \
    "${app_resources_path}/extensions/backboard/src" \
    "${app_resources_path}/extensions/backboard/tsconfig.json" \
    "${app_resources_path}/extensions/backboard/tsconfig.tsbuildinfo" \
    "${app_resources_path}/extensions/backboard/.vscodeignore"

  after_kb="$(du -sk "${APP_PATH}" | awk '{ print $1 }')"
  echo "Pruned app payload: $((before_kb - after_kb))K removed"
}

rebuild_backboard_runtime

if [[ "${SKIP_SIGNING}" != "1" && -z "${MACOS_CERTIFICATE_PASSWORD:-}" ]]; then
  if [[ -s "${P12_PASSWORD_PATH}" ]]; then
    MACOS_CERTIFICATE_PASSWORD="$(<"${P12_PASSWORD_PATH}")"
  elif [[ -t 0 ]]; then
    read -rsp "Developer ID .p12 password: " MACOS_CERTIFICATE_PASSWORD
    echo
  else
    echo "Missing signing password. Set MACOS_CERTIFICATE_PASSWORD or create ${P12_PASSWORD_PATH}." >&2
    exit 1
  fi
fi

echo "Packaging ${VSAPP} for ${CHANNEL} updates"
rm -rf "${OUT}"
mkdir -p "${OUT}/dmg"
cp -R "${VSAPP}" "${APP_PATH}"

INFO_PLIST="${APP_PATH}/Contents/Info.plist"
set_plist_string "${INFO_PLIST}" "CFBundleName" "${APP_DISPLAY_NAME}"
set_plist_string "${INFO_PLIST}" "CFBundleDisplayName" "${APP_DISPLAY_NAME}"
set_plist_string "${INFO_PLIST}" "CFBundleIdentifier" "${BUNDLE_IDENTIFIER}"
set_plist_string "${INFO_PLIST}" "CFBundleShortVersionString" "${VERSION}"
set_plist_string "${INFO_PLIST}" "CFBundleVersion" "${VERSION}"
echo "Writing Backboard release metadata"
write_release_metadata

rename_helper_app() {
  local old_name="$1"
  local new_name="$2"
  local bundle_id="$3"
  local frameworks_dir="${APP_PATH}/Contents/Frameworks"
  local new_app="${frameworks_dir}/${new_name}.app"
  local source_name=""
  local source_app=""
  local candidate

  for candidate in "${old_name}" "${old_name/Code - OSS/Backboard IDE}" "${old_name/Code - OSS/Backboard Studio Dev}" "${old_name/Code - OSS/Backboard Studio}" "${new_name}"; do
    if [[ -d "${frameworks_dir}/${candidate}.app" ]]; then
      source_name="${candidate}"
      source_app="${frameworks_dir}/${candidate}.app"
      break
    fi
  done

  if [[ -z "${source_app}" ]]; then
    echo "Missing Electron helper app: expected ${old_name}.app, ${old_name/Code - OSS/Backboard IDE}.app, ${old_name/Code - OSS/Backboard Studio Dev}.app, ${old_name/Code - OSS/Backboard Studio}.app, or ${new_name}.app" >&2
    exit 1
  fi

  if [[ "${source_app}" != "${new_app}" ]]; then
    mv "${source_app}" "${new_app}"
  fi

  local old_binary="${new_app}/Contents/MacOS/${source_name}"
  local new_binary="${new_app}/Contents/MacOS/${new_name}"
  if [[ -f "${old_binary}" ]]; then
    mv "${old_binary}" "${new_binary}"
  elif [[ ! -f "${new_binary}" ]]; then
    echo "Missing Electron helper binary: expected ${old_binary} or ${new_binary}" >&2
    exit 1
  fi

  local helper_plist="${new_app}/Contents/Info.plist"
  set_plist_string "${helper_plist}" "CFBundleName" "${new_name}"
  set_plist_string "${helper_plist}" "CFBundleDisplayName" "${new_name}"
  set_plist_string "${helper_plist}" "CFBundleExecutable" "${new_name}"
  set_plist_string "${helper_plist}" "CFBundleIdentifier" "${bundle_id}"
}

echo "Renaming Electron helper apps"
rename_helper_app "Code - OSS Helper" "${APP_DISPLAY_NAME} Helper" "${BUNDLE_IDENTIFIER}.helper"
rename_helper_app "Code - OSS Helper (GPU)" "${APP_DISPLAY_NAME} Helper (GPU)" "${BUNDLE_IDENTIFIER}.helper.GPU"
rename_helper_app "Code - OSS Helper (Plugin)" "${APP_DISPLAY_NAME} Helper (Plugin)" "${BUNDLE_IDENTIFIER}.helper.Plugin"
rename_helper_app "Code - OSS Helper (Renderer)" "${APP_DISPLAY_NAME} Helper (Renderer)" "${BUNDLE_IDENTIFIER}.helper.Renderer"

BACKBOARD_EXTENSION_PATH="${APP_PATH}/Contents/Resources/app/extensions/backboard"
if [[ -d "${BACKBOARD_EXTENSION_PATH}" ]]; then
  sync_backboard_extension_runtime
  rm -rf "${BACKBOARD_EXTENSION_PATH}/rust/target"
else
  echo "Missing Backboard extension in packaged VSCode app: ${BACKBOARD_EXTENSION_PATH}" >&2
  exit 1
fi

prune_release_app

# A cross-compiled release can pick up host-architecture binaries: the app
# installs and launches, then fails the moment it touches an affected module.
# That shipped undetected before, so the staged bundle is checked here, while
# failing is still cheap -- signing and notarizing take far longer.
#
# Vendored per-architecture payloads are deliberately foreign (the consuming
# package selects at runtime), so paths carrying an explicit architecture
# segment are exempt.
verify_release_architecture() {
  local expected_arch mismatches info relative
  case "${ARCH}" in
    aarch64) expected_arch="arm64" ;;
    x86_64) expected_arch="x86_64" ;;
    *) echo "Cannot verify architecture for ARCH=${ARCH}" >&2; exit 1 ;;
  esac

  echo "Verifying every Mach-O binary is ${expected_arch}"
  mismatches=0
  while IFS= read -r -d '' binary; do
    case "${binary}" in
      */_CodeSignature/*) continue ;;
      # Some dependencies intentionally vendor both Mac architectures in
      # directories or package names that state the architecture explicitly.
      # The build script separately requires target-architecture variants for
      # representative optional packages before this payload is assembled.
      *-darwin-x64/*|*-darwin-arm64/*|*/darwin-x64/*|*/darwin-arm64/*|*/x64-darwin/*|*/arm64-darwin/*|*/bin/x64/*|*/bin/arm64/*|*/prebuilds/darwin-x64/*|*/prebuilds/darwin-arm64/*) continue ;;
    esac
    info="$(file -b "${binary}" 2>/dev/null || true)"
    case "${info}" in
      *Mach-O*) ;;
      *) continue ;;
    esac
    case "${info}" in
      *universal*) continue ;;
      *"${expected_arch}"*) ;;
      *)
        relative="${binary#"${APP_PATH}/"}"
        echo "  not ${expected_arch}: ${relative} (${info})" >&2
        mismatches=$((mismatches + 1))
        ;;
    esac
  done < <(find "${APP_PATH}/Contents" -type f -print0)

  if (( mismatches > 0 )); then
    echo "Refusing to sign: ${mismatches} binaries are not ${expected_arch}." >&2
    exit 1
  fi
  echo "Architecture check passed"
}

verify_release_architecture

# Builds the DMG with `hdiutil makehybrid` + `hdiutil convert` instead of
# `hdiutil create -srcfolder`. The latter attaches a temp volume at /Volumes and
# copies via copy-helper, which macOS App Management (TCC) blocks from creating
# the app bundle on the mounted volume ("could not access /Volumes/<vol>/<app>
# - Operation not permitted"). makehybrid builds the filesystem in-process from
# the source folder without mounting anything, so no TCC gate applies.
# Stages the installer-window layout (background art + .DS_Store) into the DMG
# source folder so Finder shows a proper drag-to-Applications window (sized, with
# an arrow) that AUTO-OPENS on double-click, instead of the default two-icon view.
# Picks the per-channel variant. Non-fatal if the assets are missing so packaging
# still succeeds. The committed .DS_Store MUST be Finder-authored — a library-
# written one mounts but never auto-opens on Apple Silicon. Regenerate with
# scripts/dmg-assets/build_layout_assets.sh.
stage_dmg_layout() {
  local src_folder="$1"
  local ds_src bg_src
  if [[ "${CHANNEL}" == "sandbox" ]]; then
    ds_src="${DMG_ASSETS_DIR}/DS_Store-sandbox"
    bg_src="${DMG_ASSETS_DIR}/background-sandbox.tiff"
  else
    ds_src="${DMG_ASSETS_DIR}/DS_Store"
    bg_src="${DMG_ASSETS_DIR}/background.tiff"
  fi
  if [[ ! -f "${ds_src}" || ! -f "${bg_src}" ]]; then
    echo "Warning: DMG layout assets missing (${ds_src} / ${bg_src}); using Finder defaults" >&2
    return 0
  fi
  mkdir -p "${src_folder}/.background"
  cp "${bg_src}" "${src_folder}/.background/background.tiff"
  cp "${ds_src}" "${src_folder}/.DS_Store"
}

create_dmg() {
  local src_folder="$1"
  local hybrid_path="${DMG_PATH%.dmg}.hybrid.dmg"
  rm -f "${hybrid_path}" "${DMG_PATH}"
  # Installer-window chrome baked into the image: the Applications drop target
  # plus the background art and icon layout (.DS_Store).
  ln -s /Applications "${src_folder}/Applications"
  stage_dmg_layout "${src_folder}"
  if ! hdiutil makehybrid -hfs -hfs-volume-name "${DMG_VOLUME_NAME}" -o "${hybrid_path}" "${src_folder}"; then
    rm -f "${hybrid_path}" "${DMG_PATH}"
    rm -f "${src_folder}/Applications" "${src_folder}/.DS_Store"
    rm -rf "${src_folder}/.background"
    return 1
  fi
  if ! hdiutil convert "${hybrid_path}" -format "${DMG_FORMAT}" -o "${DMG_PATH}"; then
    rm -f "${hybrid_path}" "${DMG_PATH}"
    rm -f "${src_folder}/Applications" "${src_folder}/.DS_Store"
    rm -rf "${src_folder}/.background"
    return 1
  fi
  rm -f "${hybrid_path}"
  # Drop installer-only chrome from the payload folder so it can't leak into any
  # later step that operates on "${src_folder}".
  rm -f "${src_folder}/Applications" "${src_folder}/.DS_Store"
  rm -rf "${src_folder}/.background"
}

if [[ "${SKIP_SIGNING}" == "1" ]]; then
  echo "Skipping code signing because SKIP_SIGNING=1"
  echo "Creating unsigned DMG"
  create_dmg "${OUT}/dmg"
  echo "Unsigned, non-notarized DMG ready: ${DMG_PATH}"
  shasum -a 256 "${DMG_PATH}"
  stat -f%z "${DMG_PATH}"
  exit 0
fi

# `security` indents its output and wraps each path in quotes, so both have to
# come off. Stripping only the quotes leaves the leading spaces in place, which
# turns every restored entry into a bogus path and grows the search list on each
# release until it holds dozens of malformed duplicates.
strip_keychain_path() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "${value}"
}

LOGIN_KEYCHAIN_PATH="${HOME}/Library/Keychains/login.keychain-db"
ORIGINAL_DEFAULT_KEYCHAIN="$(strip_keychain_path "$(security default-keychain -d user 2>/dev/null || true)")"
if [[ "${ORIGINAL_DEFAULT_KEYCHAIN}" == "${KEYCHAIN_PATH}" || ! -e "${ORIGINAL_DEFAULT_KEYCHAIN}" ]]; then
  if [[ -e "${LOGIN_KEYCHAIN_PATH}" ]]; then
    ORIGINAL_DEFAULT_KEYCHAIN="${LOGIN_KEYCHAIN_PATH}"
  else
    ORIGINAL_DEFAULT_KEYCHAIN=""
  fi
fi
ORIGINAL_KEYCHAINS=()
while IFS= read -r keychain; do
  keychain="$(strip_keychain_path "${keychain}")"
  if [[ -n "${keychain}" && "${keychain}" != "${KEYCHAIN_PATH}" && -e "${keychain}" ]]; then
    ORIGINAL_KEYCHAINS+=("${keychain}")
  fi
done < <(security list-keychains -d user 2>/dev/null || true)
if [[ "${#ORIGINAL_KEYCHAINS[@]}" -eq 0 && -e "${LOGIN_KEYCHAIN_PATH}" ]]; then
  ORIGINAL_KEYCHAINS+=("${LOGIN_KEYCHAIN_PATH}")
fi

cleanup() {
  if [[ -n "${ORIGINAL_DEFAULT_KEYCHAIN}" ]]; then
    security default-keychain -d user -s "${ORIGINAL_DEFAULT_KEYCHAIN}" >/dev/null 2>&1 || true
  fi
  if [[ "${#ORIGINAL_KEYCHAINS[@]}" -gt 0 ]]; then
    security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "${KEYCHAIN_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "Creating signing keychain"
security create-keychain -p "${MACOS_CERTIFICATE_PASSWORD}" "${KEYCHAIN_NAME}"
security default-keychain -d user -s "${KEYCHAIN_NAME}"
if [[ "${#ORIGINAL_KEYCHAINS[@]}" -gt 0 ]]; then
  security list-keychains -d user -s "${KEYCHAIN_PATH}" "${ORIGINAL_KEYCHAINS[@]}"
else
  security list-keychains -d user -s "${KEYCHAIN_PATH}"
fi
security unlock-keychain -p "${MACOS_CERTIFICATE_PASSWORD}" "${KEYCHAIN_NAME}"
security set-keychain-settings "${KEYCHAIN_NAME}"
security import "${P12_PATH}" -k "${KEYCHAIN_NAME}" -P "${MACOS_CERTIFICATE_PASSWORD}" -T /usr/bin/codesign

INTERMEDIATE_CERTS_DIR="$(mktemp -d)"
curl --fail --silent --show-error --location \
  "https://www.apple.com/certificateauthority/DeveloperIDCA.cer" \
  --output "${INTERMEDIATE_CERTS_DIR}/DeveloperIDCA.cer"
curl --fail --silent --show-error --location \
  "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer" \
  --output "${INTERMEDIATE_CERTS_DIR}/DeveloperIDG2CA.cer"
security import "${INTERMEDIATE_CERTS_DIR}/DeveloperIDCA.cer" -k "${KEYCHAIN_NAME}" -T /usr/bin/codesign
security import "${INTERMEDIATE_CERTS_DIR}/DeveloperIDG2CA.cer" -k "${KEYCHAIN_NAME}" -T /usr/bin/codesign
rm -rf "${INTERMEDIATE_CERTS_DIR}"

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "${MACOS_CERTIFICATE_PASSWORD}" \
  "${KEYCHAIN_NAME}"

echo "Finding signing identity"
SIGNING_IDENTITIES="$(security find-identity -v -p codesigning "${KEYCHAIN_NAME}" || true)"
echo "${SIGNING_IDENTITIES}"

if [[ -n "${IDENTITY}" ]]; then
  IDENTITY_HASH="$(awk -v identity="${IDENTITY}" '$0 ~ "\"" identity "\"" { print $2; exit }' <<<"${SIGNING_IDENTITIES}")"
else
  IDENTITY_HASH="$(awk '/Developer ID Application/ { print $2; exit }' <<<"${SIGNING_IDENTITIES}")"
fi

if [[ -z "${IDENTITY_HASH}" ]]; then
  echo "No Developer ID Application signing identity found." >&2
  exit 1
fi

echo "Signing app"
sign_code() {
  local target="$1"
  shift
  codesign \
    --keychain "${KEYCHAIN_PATH}" \
    --force \
    --timestamp \
    --options runtime \
    --sign "${IDENTITY_HASH}" \
    "$@" \
    "${target}" \
    -v
}

sign_macho_file() {
  local target="$1"
  if file -b "${target}" | grep -q "Mach-O"; then
    sign_code "${target}"
  fi
}

echo "Signing nested Mach-O files"
while IFS= read -r -d '' macho_file; do
  case "${macho_file}" in
    */_CodeSignature/*) continue ;;
    # Bundle main executables -- the app's own and each helper app's. codesign
    # resolves these to their enclosing bundle, so signing one here seals that
    # whole bundle before its nested code has been signed. On arm64 that happens
    # to succeed, because the architecture requires every binary to be signed and
    # the build leaves ad-hoc signatures behind that satisfy the seal. x64 has no
    # such requirement and its helpers arrive unsigned, so the same call fails
    # with "code object is not signed at all". Each of these is sealed further
    # down by its own bundle, in the correct inside-out order.
    */Contents/MacOS/*) continue ;;
  esac
  # Framework main binaries, named <Name>.framework/Versions/<V>/<Name>. Same
  # premature seal: signing one seals the framework, which requires the Helpers
  # sitting beside it -- signed later in this very pass -- to be signed already.
  # The framework pass below seals them once their contents are ready.
  macho_base="$(basename "${macho_file}")"
  case "${macho_file}" in
    */"${macho_base}".framework/Versions/*/"${macho_base}") continue ;;
  esac
  sign_macho_file "${macho_file}"
done < <(find "${APP_PATH}/Contents" -type f -print0)

echo "Signing nested frameworks"
while IFS= read -r -d '' framework; do
  sign_code "${framework}"
done < <(find "${APP_PATH}/Contents/Frameworks" -type d -name "*.framework" -print0 2>/dev/null)

echo "Signing helper apps"
while IFS= read -r -d '' helper_app; do
  helper_entitlements="${REPO_ROOT}/vscode/build/azure-pipelines/darwin/helper-entitlements.plist"
  case "${helper_app}" in
    *" Helper (GPU).app") helper_entitlements="${REPO_ROOT}/vscode/build/azure-pipelines/darwin/helper-gpu-entitlements.plist" ;;
    *" Helper (Renderer).app") helper_entitlements="${REPO_ROOT}/vscode/build/azure-pipelines/darwin/helper-renderer-entitlements.plist" ;;
    *" Helper (Plugin).app") helper_entitlements="${REPO_ROOT}/vscode/build/azure-pipelines/darwin/helper-plugin-entitlements.plist" ;;
  esac
  sign_code "${helper_app}" --entitlements "${helper_entitlements}"
done < <(find "${APP_PATH}/Contents/Frameworks" -maxdepth 1 -type d -name "*.app" -print0 2>/dev/null)

echo "Signing main app"
codesign \
  --keychain "${KEYCHAIN_PATH}" \
  --force \
  --timestamp \
  --options runtime \
  --entitlements "${REPO_ROOT}/vscode/build/azure-pipelines/darwin/app-entitlements.plist" \
  --sign "${IDENTITY_HASH}" \
  "${APP_PATH}" \
  -v
codesign --verify --deep --strict --verbose=4 "${APP_PATH}"

echo "Creating DMG"
create_dmg "${OUT}/dmg"

echo "Signing DMG"
codesign --keychain "${KEYCHAIN_PATH}" --deep --force --timestamp --options runtime --sign "${IDENTITY_HASH}" "${DMG_PATH}" -v

if [[ "${SKIP_NOTARIZATION}" == "1" ]]; then
  echo "Skipping notarization because SKIP_NOTARIZATION=1"
  echo "Signed, non-notarized DMG ready: ${DMG_PATH}"
  shasum -a 256 "${DMG_PATH}"
  stat -f%z "${DMG_PATH}"
  exit 0
fi

echo "Submitting DMG for notarization"
NOTARY_OUTPUT="$(xcrun notarytool submit --wait \
  --key "${ASC_KEY_PATH}" \
  --key-id "${APPLE_NOTARIZATION_KEY_ID}" \
  --issuer "${APPLE_NOTARIZATION_ISSUER_ID}" \
  "${DMG_PATH}" 2>&1)"
echo "${NOTARY_OUTPUT}"

if ! grep -q "status: Accepted" <<<"${NOTARY_OUTPUT}"; then
  echo "Notarization did not return Accepted. Not stapling." >&2
  exit 1
fi

echo "Stapling notarization ticket"
xcrun stapler staple "${DMG_PATH}"
xcrun stapler validate "${DMG_PATH}"
spctl --assess --type open --context context:primary-signature -vv "${DMG_PATH}"

echo "Notarized DMG ready: ${DMG_PATH}"
shasum -a 256 "${DMG_PATH}"
stat -f%z "${DMG_PATH}"
