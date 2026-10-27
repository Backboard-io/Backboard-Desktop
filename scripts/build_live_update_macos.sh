#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_VERSION="${BASE_VERSION:-}"
CHANNEL="${CHANNEL:-stable}"
ARCH="${ARCH:-aarch64}"
COMPONENTS="${COMPONENTS:-app,agent}"
BASE_APP="${BASE_APP:-}"
LIVE_BUILD_OUT="${LIVE_BUILD_OUT:-}"
SKIP_LIVE_BUILD="${SKIP_LIVE_BUILD:-0}"

usage() {
  cat <<EOF
Usage:
  BASE_VERSION=3.1.27 CHANNEL=stable ARCH=aarch64 $0 [publish.mjs options]

Builds a live update for users on the full release BASE_VERSION and writes it to
vscode-live-updates/ for scripts/upload_live_update.sh. No signing, notarization
or DMG: the app is compiled unsigned and only its JavaScript ships.

  COMPONENTS=app,agent  app = application JavaScript (restart to apply; needs a
                        full compile, ~20 min); agent = cli-ts bundle (next turn;
                        seconds, no compile). Default: both.
  BASE_APP=PATH         The signed BASE_VERSION app users run. Default: the copy
                        under vscode-release-CHANNEL/ or vscode-release/.
  SKIP_LIVE_BUILD=1     Reuse the unsigned app from the last live build.

Extra options go to publish.mjs, e.g. --rollout 10 --notes "Fixes chat scroll" --urgent.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ -z "${BASE_VERSION}" ]]; then
  echo "Missing BASE_VERSION (the full release users run, e.g. 3.1.27)." >&2
  usage >&2
  exit 1
fi
case "${ARCH}" in
  aarch64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) echo "Unsupported ARCH=${ARCH}" >&2; exit 1 ;;
esac

find_app() {
  find "$1" -maxdepth 1 -type d -name '*.app' -print -quit 2>/dev/null || true
}

if [[ -z "${BASE_APP}" ]]; then
  for candidate in \
    "${REPO_ROOT}/vscode-release-${CHANNEL}/${BASE_VERSION}/${ARCH}/dmg" \
    "${REPO_ROOT}/vscode-release/${BASE_VERSION}/${ARCH}/dmg"; do
    BASE_APP="$(find_app "${candidate}")"
    if [[ -n "${BASE_APP}" ]]; then
      break
    fi
  done
fi
if [[ -z "${BASE_APP}" || ! -d "${BASE_APP}" ]]; then
  echo "Cannot find the signed ${BASE_VERSION} app; set BASE_APP." >&2
  exit 1
fi

PUBLISH_ARGS=(publish --channel "${CHANNEL}" --platform darwin --arch "${NODE_ARCH}" --base-app "${BASE_APP}")

if [[ ",${COMPONENTS}," == *",app,"* ]]; then
  LIVE_BUILD_OUT="${LIVE_BUILD_OUT:-${REPO_ROOT}/vscode-live-build/${CHANNEL}/${BASE_VERSION}/${ARCH}}"
  if [[ "${SKIP_LIVE_BUILD}" != "1" ]]; then
    # VERSION stays the base release: the overlay keeps the installed app's
    # product.json, and the build must match it.
    SKIP_SIGNING=1 SKIP_NOTARIZATION=1 \
      VERSION="${BASE_VERSION}" CHANNEL="${CHANNEL}" ARCH="${ARCH}" OUT="${LIVE_BUILD_OUT}" \
      "${REPO_ROOT}/scripts/build_vscode_release_macos.sh"
  fi
  NEW_APP="$(find_app "${LIVE_BUILD_OUT}/dmg")"
  if [[ -z "${NEW_APP}" ]]; then
    echo "The live build produced no app under ${LIVE_BUILD_OUT}/dmg." >&2
    exit 1
  fi
  PUBLISH_ARGS+=(--new-app "${NEW_APP}")
fi
if [[ ",${COMPONENTS}," == *",agent,"* ]]; then
  PUBLISH_ARGS+=(--agent)
fi

node "${REPO_ROOT}/scripts/live-updates/publish.mjs" "${PUBLISH_ARGS[@]}" "$@"
