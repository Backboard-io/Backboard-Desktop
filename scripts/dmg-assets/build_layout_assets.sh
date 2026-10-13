#!/usr/bin/env bash
#
# Regenerates every DMG installer-window asset: the background art (1x + 2x
# folded into one multi-resolution TIFF) and the Finder-authored .DS_Store, for
# both channels.
#
# Run this whenever the artwork or window geometry changes. The outputs are
# committed — packaging only copies them, it never regenerates them, and it
# treats them as optional, so a missing asset degrades silently to a bare Finder
# window instead of failing the build.
#
#   ./scripts/dmg-assets/build_layout_assets.sh            # both channels
#   CHANNELS=sandbox ./scripts/dmg-assets/build_layout_assets.sh

set -euo pipefail

ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

CHANNELS="${CHANNELS:-stable sandbox}"

for channel in ${CHANNELS}; do
  case "${channel}" in
    stable)  tiff="${ASSETS_DIR}/background.tiff" ;;
    sandbox) tiff="${ASSETS_DIR}/background-sandbox.tiff" ;;
    *) echo "Unsupported channel '${channel}'" >&2; exit 1 ;;
  esac

  echo "==> ${channel}: rendering background art"
  python3 "${ASSETS_DIR}/render_background.py" \
    --channel "${channel}" --scale 1 --out "${WORK}/${channel}-1x.png"
  python3 "${ASSETS_DIR}/render_background.py" \
    --channel "${channel}" --scale 2 --out "${WORK}/${channel}-2x.png"

  # tiffutil bundles the two representations so Finder picks the right one per
  # display; -cathidpicheck asserts the 2x really is double the 1x dimensions.
  tiffutil -cathidpicheck "${WORK}/${channel}-1x.png" "${WORK}/${channel}-2x.png" \
    -out "${tiff}" >/dev/null
  echo "    ${tiff} ($(stat -f%z "${tiff}") bytes)"

  echo "==> ${channel}: authoring .DS_Store via Finder"
  CHANNEL="${channel}" "${ASSETS_DIR}/author_dsstore_finder.sh"
done

echo
echo "Done. Assets in ${ASSETS_DIR}:"
ls -la "${ASSETS_DIR}" | grep -vE '^total|\.$'
