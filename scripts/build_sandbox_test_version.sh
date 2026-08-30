#!/usr/bin/env bash
# Builds a sandbox "version bump" DMG from an already-built sandbox app:
# stages the app out of the 3.0.10 DMG, bumps version metadata, re-signs with
# the Developer ID identity, notarizes, staples, and writes a local manifest.
# Used to produce consecutive sandbox versions (e.g. 3.0.11, 3.0.12) to test
# the in-app updater without a full source rebuild.
set -euo pipefail

VERSION="${1:?usage: $0 <version> e.g. $0 3.0.11}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTITLEMENTS_DIR="${REPO_ROOT}/backboard/build/azure-pipelines/darwin"
SOURCE_DMG="${SOURCE_DMG:-${REPO_ROOT}/vscode-release/3.0.10/aarch64/Backboard-Studio-aarch64.dmg}"
OUT="${REPO_ROOT}/vscode-release/${VERSION}/aarch64"
APP_NAME="Backboard Studio Sandbox.app"
STAGING_APP="${OUT}/dmg/${APP_NAME}"
DMG_PATH="${OUT}/Backboard-Studio-${ARCH:-aarch64}.dmg"
ARCH="${ARCH:-aarch64}"
CHANNEL="sandbox"
IDENTITY="${IDENTITY:-Developer ID Application: Robert Imbeault (M4UYB6AG86)}"
EXPECTED_TEAM_ID="M4UYB6AG86"
NOTARY_KEY="${HOME}/.backboard/apple-notarization-robert/AuthKey_H4T54P4BTU.p8"
NOTARY_KEY_ID="H4T54P4BTU"
NOTARY_ISSUER="11ee54e4-9610-4049-b9ed-d630e07950db"

IDENTITY_HASH="$(security find-identity -v -p codesigning | awk -v identity="${IDENTITY}" 'index($0, "\"" identity "\"") { print $2; exit }')"
if [[ -z "${IDENTITY_HASH}" ]]; then
  echo "Missing signing identity: ${IDENTITY}" >&2
  exit 1
fi

echo "=== Building sandbox ${VERSION} from ${SOURCE_DMG}"

MOUNT="$(mktemp -d /tmp/bb-src-mount.XXXXXX)"
cleanup() { /usr/bin/hdiutil detach "${MOUNT}" -quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT
/usr/bin/hdiutil attach "${SOURCE_DMG}" -mountpoint "${MOUNT}" -nobrowse -readonly -quiet

rm -rf "${OUT}"
mkdir -p "${OUT}/dmg"
/usr/bin/ditto "${MOUNT}/${APP_NAME}" "${STAGING_APP}"

echo "Bumping version metadata to ${VERSION}"
/usr/bin/xattr -cr "${STAGING_APP}"
plutil -replace CFBundleShortVersionString -string "${VERSION}" "${STAGING_APP}/Contents/Info.plist"
plutil -replace CFBundleVersion -string "${VERSION}" "${STAGING_APP}/Contents/Info.plist"
python3 - "${STAGING_APP}" "${VERSION}" <<'PYEOF'
import json, sys
app, version = sys.argv[1], sys.argv[2]

def bump(path, keys):
    with open(path) as f:
        data = json.load(f)
    for key in keys:
        if key in data:
            data[key] = version
    with open(path, 'w') as f:
        json.dump(data, f, indent='\t')
        f.write('\n')

res = f"{app}/Contents/Resources/app"
bump(f"{res}/product.json", ["backboardVersion", "backboardStudioVersion"])
bump(f"{res}/backboard-build-info.json", ["version"])
PYEOF

echo "Signing nested Mach-O files"
sign_code() {
  codesign --force --timestamp --options runtime --sign "${IDENTITY_HASH}" "$@" -v
}
while IFS= read -r -d '' macho_file; do
  case "${macho_file}" in
    */_CodeSignature/*) continue ;;
    */Contents/MacOS/*) continue ;;
  esac
  macho_base="$(basename "${macho_file}")"
  case "${macho_file}" in
    */"${macho_base}".framework/Versions/*/"${macho_base}") continue ;;
  esac
  if file -b "${macho_file}" | grep -q "Mach-O"; then
    sign_code "${macho_file}"
  fi
done < <(find "${STAGING_APP}/Contents" -type f -print0)

echo "Signing nested frameworks"
while IFS= read -r -d '' framework; do
  sign_code "${framework}"
done < <(find "${STAGING_APP}/Contents/Frameworks" -type d -name "*.framework" -print0 2>/dev/null)

echo "Signing helper apps"
while IFS= read -r -d '' helper_app; do
  helper_entitlements="${ENTITLEMENTS_DIR}/helper-entitlements.plist"
  case "${helper_app}" in
    *" Helper (GPU).app") helper_entitlements="${ENTITLEMENTS_DIR}/helper-gpu-entitlements.plist" ;;
    *" Helper (Renderer).app") helper_entitlements="${ENTITLEMENTS_DIR}/helper-renderer-entitlements.plist" ;;
    *" Helper (Plugin).app") helper_entitlements="${ENTITLEMENTS_DIR}/helper-plugin-entitlements.plist" ;;
  esac
  sign_code "${helper_app}" --entitlements "${helper_entitlements}"
done < <(find "${STAGING_APP}/Contents/Frameworks" -maxdepth 1 -type d -name "*.app" -print0 2>/dev/null)

echo "Signing main app"
sign_code "${STAGING_APP}" --entitlements "${ENTITLEMENTS_DIR}/app-entitlements.plist"

codesign --verify --deep --strict --verbose=2 "${STAGING_APP}" 2>&1 | tail -2
TEAM_ID="$(codesign -dvvv "${STAGING_APP}" 2>&1 | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
[[ "${TEAM_ID}" == "${EXPECTED_TEAM_ID}" ]] || { echo "team mismatch: ${TEAM_ID}"; exit 1; }

echo "Creating DMG"
ln -sf /Applications "${OUT}/dmg/Applications"
RAW_DMG="${OUT}/.raw-${VERSION}.dmg"
rm -f "${RAW_DMG}"
DMG_SIZE_MB=$(( $(du -sm "${OUT}/dmg" | awk '{print $1}') + 200 ))
/usr/bin/hdiutil create -size "${DMG_SIZE_MB}m" -fs HFS+ -volname "Backboard Studio Sandbox" -ov "${RAW_DMG}"
DMG_MOUNT="$(mktemp -d /tmp/bb-dst-mount.XXXXXX)"
/usr/bin/hdiutil attach "${RAW_DMG}" -mountpoint "${DMG_MOUNT}" -nobrowse -quiet
/usr/bin/ditto "${OUT}/dmg/." "${DMG_MOUNT}"
/usr/bin/hdiutil detach "${DMG_MOUNT}" -quiet
rmdir "${DMG_MOUNT}"
rm -f "${DMG_PATH}"
/usr/bin/hdiutil convert "${RAW_DMG}" -format ULMO -o "${DMG_PATH}"
rm -f "${RAW_DMG}"

echo "Signing DMG"
codesign --deep --force --timestamp --options runtime --sign "${IDENTITY_HASH}" "${DMG_PATH}" -v

echo "Notarizing DMG (this takes a few minutes)"
NOTARY_OUTPUT="$(xcrun notarytool submit --wait --key "${NOTARY_KEY}" --key-id "${NOTARY_KEY_ID}" --issuer "${NOTARY_ISSUER}" "${DMG_PATH}" 2>&1)"
echo "${NOTARY_OUTPUT}"
grep -q "status: Accepted" <<<"${NOTARY_OUTPUT}" || { echo "Notarization rejected"; exit 1; }

echo "Stapling"
xcrun stapler staple "${DMG_PATH}"
xcrun stapler validate "${DMG_PATH}"
spctl --assess --type open --context context:primary-signature -vv "${DMG_PATH}"

SHA256="$(shasum -a 256 "${DMG_PATH}" | awk '{print $1}')"
BYTES="$(stat -f%z "${DMG_PATH}")"
cat > "${OUT}/macos-${ARCH}.json" <<EOF
{
  "version": "${VERSION}",
  "url": "https://backboard-studio-releases.s3.ca-central-1.amazonaws.com/ide-releases/${CHANNEL}/${VERSION}/bbide/macos-${ARCH}/Backboard-Studio-${ARCH}.dmg",
  "sha256": "${SHA256}",
  "size_bytes": ${BYTES}
}
EOF

echo "=== Done: ${DMG_PATH}"
echo "    sha256: ${SHA256}"
echo "    bytes:  ${BYTES}"
