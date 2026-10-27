#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUCKET="${BUCKET:-backboard-studio-releases}"
REGION="${REGION:-ca-central-1}"
PREFIX="${LIVE_UPDATE_PREFIX:-ide-releases/live}"
LIVE_ROOT="${LIVE_ROOT:-${REPO_ROOT}/vscode-live-updates}"
CHANNEL=""
PLATFORM=""
DRY_RUN=0
AWS_PROFILE_NAME="${AWS_PROFILE:-}"
# Optional: the events server's publish endpoint, so connected apps fetch now
# instead of at their next poll. Needs BACKBOARD_LIVE_EVENTS_TOKEN.
NOTIFY_URL="${BACKBOARD_LIVE_EVENTS_PUBLISH_URL:-}"

usage() {
  cat <<EOF
Usage:
  $0 --channel stable --platform darwin-arm64 [--dry-run]

Uploads one live update channel folder written by scripts/live-updates/publish.mjs.
Content-addressed objects and file lists go first, the manifest last, so an app
never reads a manifest whose files are not there yet.

  s3://BUCKET/${PREFIX}/CHANNEL/PLATFORM/objects/...    immutable, cached for a year
  s3://BUCKET/${PREFIX}/CHANNEL/PLATFORM/files/...      immutable, cached for a year
  s3://BUCKET/${PREFIX}/CHANNEL/PLATFORM/manifest.json  no-cache

Options:
  --channel CHANNEL    stable or sandbox
  --platform PLATFORM  darwin-arm64, darwin-x64, win32-x64, linux-x64, ...
  --bucket BUCKET      Default: ${BUCKET}
  --region REGION      Default: ${REGION}
  --profile PROFILE    AWS CLI profile, e.g. backboard-release. Default: \$AWS_PROFILE
  --notify URL         Events server publish URL. Default: \$BACKBOARD_LIVE_EVENTS_PUBLISH_URL
  --dry-run            Print what would be uploaded
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) AWS_PROFILE_NAME="$2"; shift 2 ;;
    --notify) NOTIFY_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "${CHANNEL}" in
  stable|sandbox) ;;
  *) echo "--channel must be stable or sandbox" >&2; exit 1 ;;
esac
if [[ ! "${PLATFORM}" =~ ^(darwin|win32|linux)-(arm64|x64)$ ]]; then
  echo "--platform must look like darwin-arm64" >&2
  exit 1
fi

SOURCE="${LIVE_ROOT}/${CHANNEL}/${PLATFORM}"
if [[ ! -f "${SOURCE}/manifest.json" ]]; then
  echo "No manifest at ${SOURCE}/manifest.json. Run scripts/live-updates/publish.mjs first." >&2
  exit 1
fi

if [[ "${DRY_RUN}" -eq 0 ]] && ! command -v aws >/dev/null 2>&1; then
  echo "Missing aws CLI. Install/configure AWS CLI first, or run with --dry-run." >&2
  exit 1
fi

AWS_GLOBAL_ARGS=()
if [[ -n "${AWS_PROFILE_NAME}" ]]; then
  AWS_GLOBAL_ARGS+=(--profile "${AWS_PROFILE_NAME}")
fi
if [[ -n "${REGION}" ]]; then
  AWS_GLOBAL_ARGS+=(--region "${REGION}")
fi
aws_cmd() {
  # Empty arrays need this form under `set -u` in macOS's bash 3.2.
  aws ${AWS_GLOBAL_ARGS[@]+"${AWS_GLOBAL_ARGS[@]}"} "$@"
}

TARGET="s3://${BUCKET}/${PREFIX}/${CHANNEL}/${PLATFORM}"

for folder in objects files; do
  if [[ -d "${SOURCE}/${folder}" ]]; then
    echo "Syncing ${folder}/ ($(find "${SOURCE}/${folder}" -type f | wc -l | tr -d ' ') files) -> ${TARGET}/${folder}/"
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      echo "  [dry-run] skipped"
      continue
    fi
    # Names are content hashes, so an existing key never needs replacing.
    aws_cmd s3 sync "${SOURCE}/${folder}" "${TARGET}/${folder}" \
      --size-only \
      --content-type application/gzip \
      --cache-control "public, max-age=31536000, immutable"
  fi
done

echo "Uploading manifest.json -> ${TARGET}/manifest.json"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  [dry-run] skipped"
else
  aws_cmd s3 cp "${SOURCE}/manifest.json" "${TARGET}/manifest.json" \
    --content-type application/json \
    --cache-control "no-cache"
fi

if [[ -n "${NOTIFY_URL}" && "${DRY_RUN}" -eq 0 ]]; then
  node "${REPO_ROOT}/scripts/live-updates/publish.mjs" notify \
    --channel "${CHANNEL}" --platform "${PLATFORM%-*}" --arch "${PLATFORM#*-}" \
    --out "${LIVE_ROOT}" --url "${NOTIFY_URL}"
fi

if [[ -n "${REGION}" ]]; then
  echo "Manifest URL: https://${BUCKET}.s3.${REGION}.amazonaws.com/${PREFIX}/${CHANNEL}/${PLATFORM}/manifest.json"
fi
