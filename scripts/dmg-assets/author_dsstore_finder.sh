#!/usr/bin/env bash
#
# Authors the installer-window .DS_Store by driving the real Finder.
#
# This MUST go through Finder. A .DS_Store written by a library (ds_store,
# dmgbuild, etc.) mounts fine but never auto-opens its window on Apple Silicon,
# which is the whole point of shipping one. Finder is the only writer that
# produces the bplist Finder itself will honour.
#
# Two details that silently break the result if changed:
#   * The scratch volume name must equal the shipping DMG's volume name. Finder
#     records the background as a volume-relative path, so a mismatch leaves the
#     window with no artwork.
#   * The placeholder bundle must be named exactly like the shipping app. Icon
#     positions are keyed by filename.
#
# The placeholder is an empty directory rather than a copy of the signed app:
# nothing here needs the real payload, and copying a genuine .app onto a mounted
# volume trips macOS App Management (TCC).

set -euo pipefail

ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHANNEL="${CHANNEL:-${1:-}}"
if [[ -z "${CHANNEL}" ]]; then
  echo "Usage: CHANNEL=stable|sandbox $0" >&2
  exit 1
fi

case "${CHANNEL}" in
  stable)
    APP_DISPLAY_NAME="Backboard Studio"
    BG_SRC="${ASSETS_DIR}/background.tiff"
    DS_OUT="${ASSETS_DIR}/DS_Store"
    ;;
  sandbox)
    APP_DISPLAY_NAME="Backboard Studio Sandbox"
    BG_SRC="${ASSETS_DIR}/background-sandbox.tiff"
    DS_OUT="${ASSETS_DIR}/DS_Store-sandbox"
    ;;
  *)
    echo "Unsupported CHANNEL=${CHANNEL}; expected stable or sandbox" >&2
    exit 1
    ;;
esac

if [[ ! -f "${BG_SRC}" ]]; then
  echo "Missing background art: ${BG_SRC} (run render_background.py first)" >&2
  exit 1
fi

# Geometry comes from the renderer so art and icon placement cannot drift.
GEOM="$(python3 "${ASSETS_DIR}/render_background.py" --dump-geometry)"
read -r WIN_W WIN_H ICON_SIZE ICON_CY APP_CX APPS_CX <<<"$(
  python3 -c '
import json,sys
g=json.loads(sys.argv[1])
print(g["width"],g["height"],g["icon_size"],g["icon_center_y"],g["app_center_x"],g["apps_center_x"])
' "${GEOM}"
)"

VOLNAME="${APP_DISPLAY_NAME}"
APP_NAME="${APP_DISPLAY_NAME}.app"
WORK="$(mktemp -d)"
SCRATCH_DMG="${WORK}/authoring.dmg"
MNT=""

cleanup() {
  if [[ -n "${MNT}" && -d "${MNT}" ]]; then
    hdiutil detach "${MNT}" -force >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "Authoring ${CHANNEL} .DS_Store on volume '${VOLNAME}'"

# A stale mount of the same name would push this one to "<name> 1", which breaks
# the volume-relative background path.
if [[ -d "/Volumes/${VOLNAME}" ]]; then
  echo "Detaching stale /Volumes/${VOLNAME}"
  hdiutil detach "/Volumes/${VOLNAME}" -force >/dev/null 2>&1 || true
fi

# Stage the volume contents on the local disk, where creating a .app is allowed.
# Creating one directly on a mounted volume is refused by macOS App Management
# (TCC) with "Operation not permitted", so the layout is baked into the image by
# makehybrid — which builds the filesystem in-process, without ever mounting —
# and only then converted to something writable. By the time Finder sees the
# volume, the bundle already exists and Finder only has to write .DS_Store.
STAGE="${WORK}/stage"
mkdir -p "${STAGE}/${APP_NAME}"
ln -sf /Applications "${STAGE}/Applications"
mkdir -p "${STAGE}/.background"
cp "${BG_SRC}" "${STAGE}/.background/background.tiff"

hdiutil makehybrid -hfs -hfs-volume-name "${VOLNAME}" \
  -o "${WORK}/hybrid.dmg" "${STAGE}" >/dev/null
hdiutil convert "${WORK}/hybrid.dmg" -format UDRW -o "${SCRATCH_DMG}" >/dev/null

# makehybrid sizes the image to its contents exactly, leaving zero free space —
# Finder would fail to write .DS_Store with "no space left on device".
hdiutil resize -size 64m "${SCRATCH_DMG}" >/dev/null

# Must be browsable and mounted under /Volumes: Finder addresses the disk by
# name, and cannot see a -nobrowse mount or one parked in a temp directory.
ATTACH_OUT="$(hdiutil attach "${SCRATCH_DMG}" -noautoopen)"
MNT="$(printf '%s\n' "${ATTACH_OUT}" | grep -o '/Volumes/.*' | tail -1)"
if [[ -z "${MNT}" || ! -d "${MNT}" ]]; then
  echo "Could not determine mount point from:" >&2
  printf '%s\n' "${ATTACH_OUT}" >&2
  exit 1
fi

# Use the name macOS actually assigned, so AppleScript targets the right disk.
VOLNAME="$(basename "${MNT}")"
echo "Mounted at ${MNT}"

# Finder needs the window height to include the title bar, otherwise the content
# area comes up short and the bottom of the artwork is cropped.
TITLEBAR=28
BOUND_R=$(( 220 + WIN_W ))
BOUND_B=$(( 160 + WIN_H + TITLEBAR ))

osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "${VOLNAME}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {220, 160, ${BOUND_R}, ${BOUND_B}}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${ICON_SIZE}
    set text size of viewOptions to 12
    set label position of viewOptions to bottom
    set shows item info of viewOptions to false
    set shows icon preview of viewOptions to false
    set background picture of viewOptions to file ".background:background.tiff"
    set position of item "${APP_NAME}" of container window to {${APP_CX}, ${ICON_CY}}
    set position of item "Applications" of container window to {${APPS_CX}, ${ICON_CY}}
    update without registering applications
    delay 1
    close
  end tell
end tell
APPLESCRIPT

# Give Finder a beat to flush the window state, then force it to disk.
sleep 3
sync

if [[ ! -f "${MNT}/.DS_Store" ]]; then
  echo "Finder did not write a .DS_Store on ${MNT}" >&2
  exit 1
fi

cp "${MNT}/.DS_Store" "${DS_OUT}"
hdiutil detach "${MNT}" >/dev/null
rm -rf "${MNT}"

echo "Wrote ${DS_OUT} ($(stat -f%z "${DS_OUT}") bytes)"
