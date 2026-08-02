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

BACKBOARD_EXTENSION_SOURCE="${VSCODE_ROOT}/extensions/backboard"
BACKBOARD_CLI_SOURCE="${BACKBOARD_EXTENSION_SOURCE}/bin/backboard-cli-ts"

rebuild_backboard_runtime() {
  if [[ "${SKIP_BACKBOARD_REBUILD:-0}" == "1" ]]; then
    return
  fi

  echo "Rebuilding Backboard extension and CLI runtime"
  (cd "${VSCODE_ROOT}" && npm --prefix extensions/backboard run compile)
  (cd "${BACKBOARD_EXTENSION_SOURCE}" && npm run package-cli-ts)
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
  read -rsp "Developer ID .p12 password: " MACOS_CERTIFICATE_PASSWORD
  echo
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
  hdiutil makehybrid -hfs -hfs-volume-name "${DMG_VOLUME_NAME}" -o "${hybrid_path}" "${src_folder}"
  hdiutil convert "${hybrid_path}" -format "${DMG_FORMAT}" -o "${DMG_PATH}"
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

ORIGINAL_DEFAULT_KEYCHAIN="$(security default-keychain -d user 2>/dev/null | tr -d '"' || true)"
ORIGINAL_KEYCHAINS=()
while IFS= read -r keychain; do
  keychain="${keychain%\"}"
  keychain="${keychain#\"}"
  [[ -n "${keychain}" ]] && ORIGINAL_KEYCHAINS+=("${keychain}")
done < <(security list-keychains -d user 2>/dev/null || true)

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
