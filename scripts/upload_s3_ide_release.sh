#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUCKET="${BUCKET:-backboard-studio-releases}"
REGION="${REGION:-ca-central-1}"
CHANNEL="${CHANNEL:-stable}"
ASSET="${ASSET:-bbide}"
VERSION="${VERSION:-}"
RELEASE_ROOT="${RELEASE_ROOT:-${REPO_ROOT}/vscode-release}"
DRY_RUN=0
VERIFY_PUBLIC=0
UPLOAD_LATEST_DMG=1
PUBLISH_LATEST=1
FORCE=0
ALLOW_UNSIGNED_SANDBOX=0
AWS_PROFILE_NAME="${AWS_PROFILE:-}"
# Large signed DMGs should survive brief endpoint/network interruptions without
# restarting the entire multipart transfer. Callers can still override either.
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-adaptive}"
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-20}"
UPDATER_TEST_SOURCE_APP="${UPDATER_TEST_SOURCE_APP:-}"
UPDATER_TEST_INSTALLER_MODULE="${UPDATER_TEST_INSTALLER_MODULE:-}"
ARCHES=()

usage() {
  cat <<EOF
Usage:
  VERSION=2.0.1 $0
  $0 --version 2.0.1 --arch aarch64

Uploads Backboard Studio release artifacts to S3. By default this also moves the
selected channel's latest manifest. Use --versioned-only for a manual release.

Versioned objects:
  s3://BUCKET/ide-releases/CHANNEL/VERSION/ASSET/macos-ARCH/Backboard-Studio-ARCH.dmg
  s3://BUCKET/ide-releases/CHANNEL/VERSION/ASSET/macos-ARCH.json

Latest objects (omitted with --versioned-only):
  s3://BUCKET/ide-releases/CHANNEL/latest/ASSET/macos-ARCH.json
  s3://BUCKET/ide-releases/CHANNEL/latest/ASSET/macos-ARCH/Backboard-Studio-ARCH.dmg

Options:
  --version VERSION       Release version, e.g. 2.0.1
  --arch ARCH            Upload one arch only. Can be repeated. Defaults to every local DMG under the version folder.
  --bucket BUCKET        S3 bucket. Default: ${BUCKET}
  --region REGION        AWS region / public URL region. Default: ${REGION}
  --channel CHANNEL      Release channel. Default: ${CHANNEL}
  --asset ASSET          Release asset name. Default: ${ASSET}
  --release-root DIR     Local release root. Default: ${RELEASE_ROOT}
  --profile PROFILE      AWS CLI profile name.
  --dry-run              Print what would upload and still regenerate local manifests.
  --force                Allow overwriting versioned release S3 objects.
  --verify-public        After upload, curl the public versioned manifest and DMG, plus latest when published.
  --allow-unsigned-sandbox
                         Permit an unsigned/non-notarized sandbox artifact. Never valid for stable.
  --updater-test-source-app APP
                         Previous signed app release to upgrade in the mandatory disposable E2E test.
                         Required when publishing latest for sandbox or stable.
  --updater-test-installer-module FILE
                         Previous release's updatesInstaller.js. Defaults to the module inside APP.
  --versioned-only       Upload only immutable versioned objects for a manual release; do not change latest.
  --no-latest-dmg        Do not upload the duplicate latest DMG object; still updates latest manifest.
  -h, --help             Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --arch)
      ARCHES+=("$2")
      shift 2
      ;;
    --bucket)
      BUCKET="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    --asset)
      ASSET="$2"
      shift 2
      ;;
    --release-root)
      RELEASE_ROOT="$2"
      shift 2
      ;;
    --profile)
      AWS_PROFILE_NAME="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --verify-public)
      VERIFY_PUBLIC=1
      shift
      ;;
    --allow-unsigned-sandbox)
      ALLOW_UNSIGNED_SANDBOX=1
      shift
      ;;
    --updater-test-source-app)
      UPDATER_TEST_SOURCE_APP="$2"
      shift 2
      ;;
    --updater-test-installer-module)
      UPDATER_TEST_INSTALLER_MODULE="$2"
      shift 2
      ;;
    --versioned-only)
      PUBLISH_LATEST=0
      UPLOAD_LATEST_DMG=0
      shift
      ;;
    --no-latest-dmg)
      UPLOAD_LATEST_DMG=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${VERSION}" ]]; then
  echo "Missing VERSION. Use --version 2.0.1 or VERSION=2.0.1." >&2
  exit 1
fi

if [[ ! "${VERSION}" =~ ^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid VERSION '${VERSION}'. Expected semver like 2.0.1, optionally with -rc.1 or +build metadata." >&2
  exit 1
fi

if [[ "${CHANNEL}" != "stable" && "${CHANNEL}" != "preview" && "${CHANNEL}" != "nightly" && "${CHANNEL}" != "dev" && "${CHANNEL}" != "sandbox" ]]; then
  echo "Unsupported channel: ${CHANNEL}" >&2
  exit 1
fi

if [[ "${ASSET}" != "bbide" ]]; then
  echo "Refusing to upload unexpected asset '${ASSET}'. Use ASSET=bbide unless the updater code changed." >&2
  exit 1
fi

if [[ "${ALLOW_UNSIGNED_SANDBOX}" -eq 1 && "${CHANNEL}" != "sandbox" ]]; then
  echo "--allow-unsigned-sandbox is restricted to the sandbox channel." >&2
  exit 1
fi

if [[ "${ALLOW_UNSIGNED_SANDBOX}" -eq 1 && "${PUBLISH_LATEST}" -eq 1 ]]; then
  echo "Unsigned sandbox artifacts may only be uploaded with --versioned-only; refusing to publish latest." >&2
  exit 1
fi

if [[ "${PUBLISH_LATEST}" -eq 1 && ( "${CHANNEL}" == "stable" || "${CHANNEL}" == "sandbox" ) && -z "${UPDATER_TEST_SOURCE_APP}" ]]; then
  echo "Publishing ${CHANNEL} latest requires --updater-test-source-app with the previous signed release." >&2
  echo "Use --versioned-only for a one-time manual bootstrap that cannot pass the previous updater." >&2
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
  aws "${AWS_GLOBAL_ARGS[@]}" "$@"
}

file_size() {
  local path="$1"
  if stat -f%z "${path}" >/dev/null 2>&1; then
    stat -f%z "${path}"
  else
    stat -c%s "${path}"
  fi
}

public_base_url() {
  if [[ -n "${REGION}" ]]; then
    printf "https://%s.s3.%s.amazonaws.com" "${BUCKET}" "${REGION}"
  else
    printf "https://%s.s3.amazonaws.com" "${BUCKET}"
  fi
}

upload_file() {
  local source="$1"
  local key="$2"
  local content_type="$3"
  local cache_control="$4"
  local allow_overwrite="${5:-0}"
  local target="s3://${BUCKET}/${key}"

  echo "Uploading ${source}"
  echo "  -> ${target}"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  [dry-run] skipped"
    return
  fi

  if [[ "${allow_overwrite}" -ne 1 && "${FORCE}" -ne 1 ]]; then
    if aws_cmd s3api head-object --bucket "${BUCKET}" --key "${key}" >/dev/null 2>&1; then
      echo "Refusing to overwrite existing versioned S3 object: ${target}" >&2
      echo "Use --force only if you intentionally want to replace that exact versioned object." >&2
      exit 1
    fi
  fi

  aws_cmd s3 cp "${source}" "${target}" \
    --content-type "${content_type}" \
    --cache-control "${cache_control}"
}

head_object() {
  local key="$1"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    return
  fi
  aws_cmd s3api head-object \
    --bucket "${BUCKET}" \
    --key "${key}" \
    --query '{ContentLength:ContentLength,ContentType:ContentType,CacheControl:CacheControl}' \
    --output json
}

discover_arches() {
  local version_dir="${RELEASE_ROOT}/${VERSION}"
  if [[ ! -d "${version_dir}" ]]; then
    echo "Missing release directory: ${version_dir}" >&2
    exit 1
  fi

  local found=()
  while IFS= read -r dmg; do
    local name arch
    name="$(basename "${dmg}")"
    arch="${name#Backboard-Studio-}"
    arch="${arch%.dmg}"
    found+=("${arch}")
  done < <(find "${version_dir}" -mindepth 2 -maxdepth 2 -type f -name 'Backboard-Studio-*.dmg' | sort)

  if [[ "${#found[@]}" -eq 0 ]]; then
    echo "No Backboard-Studio-*.dmg files found under ${version_dir}" >&2
    exit 1
  fi

  printf "%s\n" "${found[@]}"
}

if [[ "${#ARCHES[@]}" -eq 0 ]]; then
  while IFS= read -r discovered_arch; do
    ARCHES+=("${discovered_arch}")
  done < <(discover_arches)
fi

BASE_URL="$(public_base_url)"

echo "Bucket: ${BUCKET}"
echo "Region: ${REGION}"
echo "Channel: ${CHANNEL}"
echo "Asset: ${ASSET}"
echo "Version: ${VERSION}"
echo "Release root: ${RELEASE_ROOT}"
echo "Architectures: ${ARCHES[*]}"
if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
  echo "Publish latest: yes"
else
  echo "Publish latest: no (manual/versioned-only release)"
fi
echo

for arch in "${ARCHES[@]}"; do
  case "${arch}" in
    aarch64|x86_64) ;;
    *) echo "Unsupported arch: ${arch}; expected aarch64 or x86_64" >&2; exit 1 ;;
  esac

  release_dir="${RELEASE_ROOT}/${VERSION}/${arch}"
  dmg_name="Backboard-Studio-${arch}.dmg"
  dmg_path="${release_dir}/${dmg_name}"
  manifest_name="macos-${arch}.json"
  manifest_path="${release_dir}/${manifest_name}"

  if [[ ! -f "${dmg_path}" ]]; then
    echo "Missing DMG for ${arch}: ${dmg_path}" >&2
    exit 1
  fi

  echo "Running mandatory macOS release-readiness validation for ${arch}"
  validation_args=(
    --version "${VERSION}"
    --arch "${arch}"
    --channel "${CHANNEL}"
    --dmg "${dmg_path}"
  )
  if [[ -n "${EXPECTED_TEAM_ID:-}" ]]; then
    validation_args+=(--expected-team-id "${EXPECTED_TEAM_ID}")
  fi
  if [[ "${ALLOW_UNSIGNED_SANDBOX}" -eq 1 ]]; then
    validation_args+=(--allow-unsigned-sandbox)
  fi
  "${REPO_ROOT}/scripts/validate_macos_release.sh" "${validation_args[@]}"
  echo

  if [[ "${PUBLISH_LATEST}" -eq 1 && ( "${CHANNEL}" == "stable" || "${CHANNEL}" == "sandbox" ) ]]; then
    if [[ ! -d "${UPDATER_TEST_SOURCE_APP}" ]]; then
      echo "Updater E2E source app does not exist: ${UPDATER_TEST_SOURCE_APP}" >&2
      exit 1
    fi

    previous_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${UPDATER_TEST_SOURCE_APP}/Contents/Info.plist" 2>/dev/null || true)"
    if [[ -z "${previous_version}" ]]; then
      echo "Could not read the updater E2E source version from ${UPDATER_TEST_SOURCE_APP}." >&2
      exit 1
    fi
    if [[ "${previous_version}" == "${VERSION}" ]]; then
      echo "Updater E2E must cross a real version boundary; source and candidate are both ${VERSION}." >&2
      exit 1
    fi

    previous_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${UPDATER_TEST_SOURCE_APP}/Contents/Info.plist" 2>/dev/null || true)"
    previous_binary="${UPDATER_TEST_SOURCE_APP}/Contents/MacOS/${previous_executable}"
    if [[ -z "${previous_executable}" || ! -x "${previous_binary}" ]]; then
      echo "Updater E2E source app executable is missing: ${previous_binary}" >&2
      exit 1
    fi
    previous_binary_info="$(file -b "${previous_binary}")"
    case "${arch}" in
      aarch64)
        [[ "${previous_binary_info}" == *arm64* ]] || { echo "Updater E2E source is not arm64: ${previous_binary_info}" >&2; exit 1; }
        ;;
      x86_64)
        [[ "${previous_binary_info}" == *x86_64* ]] || { echo "Updater E2E source is not x86_64: ${previous_binary_info}" >&2; exit 1; }
        ;;
    esac

    updater_installer_module="${UPDATER_TEST_INSTALLER_MODULE}"
    if [[ -z "${updater_installer_module}" ]]; then
      updater_installer_module="${UPDATER_TEST_SOURCE_APP}/Contents/Resources/app/extensions/backboard/out/updatesInstaller.js"
    fi
    if [[ ! -f "${updater_installer_module}" ]]; then
      echo "Previous updater installer module is missing: ${updater_installer_module}" >&2
      exit 1
    fi

    echo "Running mandatory ${previous_version} -> ${VERSION} updater E2E for ${arch}"
    "${REPO_ROOT}/scripts/test_macos_updater_e2e.sh" \
      "${CHANNEL}" \
      "${UPDATER_TEST_SOURCE_APP}" \
      "${dmg_path}" \
      "${VERSION}" \
      "${updater_installer_module}"
    echo
  fi

  version_prefix="ide-releases/${CHANNEL}/${VERSION}/${ASSET}"
  latest_prefix="ide-releases/${CHANNEL}/latest/${ASSET}"
  dmg_key="${version_prefix}/macos-${arch}/${dmg_name}"
  manifest_key="${version_prefix}/${manifest_name}"
  latest_manifest_key="${latest_prefix}/${manifest_name}"
  latest_dmg_key="${latest_prefix}/macos-${arch}/${dmg_name}"
  dmg_url="${BASE_URL}/${dmg_key}"
  latest_manifest_url="${BASE_URL}/${latest_manifest_key}"

  sha256="$(shasum -a 256 "${dmg_path}" | awk '{print $1}')"
  size_bytes="$(file_size "${dmg_path}")"

  mkdir -p "${release_dir}"
  cat > "${manifest_path}" <<JSON
{
  "version": "${VERSION}",
  "url": "${dmg_url}",
  "sha256": "${sha256}",
  "size_bytes": ${size_bytes}
}
JSON

  echo "Generated manifest: ${manifest_path}"
  cat "${manifest_path}"
  echo

  upload_file "${dmg_path}" "${dmg_key}" "application/x-apple-diskimage" "public, max-age=31536000, immutable" 0
  upload_file "${manifest_path}" "${manifest_key}" "application/json" "no-cache, max-age=60" 0
  if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
    if [[ "${UPLOAD_LATEST_DMG}" -eq 1 ]]; then
      upload_file "${dmg_path}" "${latest_dmg_key}" "application/x-apple-diskimage" "no-cache, max-age=60" 1
    fi
    # Publish the small pointer last so clients cannot discover the release
    # before every artifact referenced by it is available.
    upload_file "${manifest_path}" "${latest_manifest_key}" "application/json" "no-cache, max-age=60" 1
  fi

  echo "S3 object checks for ${arch}:"
  head_object "${dmg_key}" || true
  head_object "${manifest_key}" || true
  if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
    head_object "${latest_manifest_key}" || true
    if [[ "${UPLOAD_LATEST_DMG}" -eq 1 ]]; then
      head_object "${latest_dmg_key}" || true
    fi
  fi
  echo

  echo "Versioned DMG URL:"
  echo "${dmg_url}"
  echo "Versioned manifest URL:"
  echo "${BASE_URL}/${manifest_key}"
  if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
    echo "Latest manifest URL:"
    echo "${latest_manifest_url}"
    if [[ "${UPLOAD_LATEST_DMG}" -eq 1 ]]; then
      echo "Latest DMG URL:"
      echo "${BASE_URL}/${latest_dmg_key}"
    fi
  fi
  echo

  if [[ "${VERIFY_PUBLIC}" -eq 1 && "${DRY_RUN}" -eq 0 ]]; then
    echo "Public versioned manifest:"
    curl -fsS "${BASE_URL}/${manifest_key}"
    echo
    echo "Public versioned DMG headers:"
    curl -fsSI "${dmg_url}" | sed -n '1,20p'
    echo
    if [[ "${PUBLISH_LATEST}" -eq 1 ]]; then
      echo "Public latest manifest:"
      curl -fsS "${latest_manifest_url}"
      echo
    fi
  fi
done

echo "Done."
