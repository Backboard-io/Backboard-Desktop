#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-${1:-}}"
ARCH="${ARCH:-x86_64}"
CHANNEL="${CHANNEL:-stable}"
NODE_VERSION="${NODE_VERSION:-24.15.0}"
BUN_VERSION="${BUN_VERSION:-1.3.14}"
BUILD_JOBS="${BUILD_JOBS:-6}"

if [[ -z "${VERSION}" ]]; then
	echo "Missing VERSION. Example: VERSION=2.5.5 $0" >&2
	exit 1
fi
if [[ "${ARCH}" != "x86_64" ]]; then
	echo "This builder currently supports ARCH=x86_64 only." >&2
	exit 1
fi
case "${CHANNEL}" in
	stable|sandbox) ;;
	*) echo "Unsupported CHANNEL=${CHANNEL}; expected stable or sandbox." >&2; exit 1 ;;
esac

DOCKER=()
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
	DOCKER=(docker)
else
	LIMA_HOME_PATH="${HOME}/.colima/_lima"
	if command -v limactl >/dev/null 2>&1 \
		&& env LIMA_HOME="${LIMA_HOME_PATH}" limactl shell colima -- sudo docker info >/dev/null 2>&1; then
		DOCKER=(env LIMA_HOME="${LIMA_HOME_PATH}" limactl shell colima -- sudo docker)
	else
		echo "No usable Docker daemon was found. Start Docker Desktop or the Backboard Colima VM." >&2
		exit 1
	fi
fi

DOCKER_ARCH="$("${DOCKER[@]}" info --format '{{.Architecture}}')"
case "${DOCKER_ARCH}" in
	x86_64|amd64) ;;
	*) echo "Docker is running as ${DOCKER_ARCH}; an x86_64 daemon is required." >&2; exit 1 ;;
esac

SOURCE_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
if [[ ! "${SOURCE_COMMIT}" =~ ^[0-9a-fA-F]{40}$ ]]; then
	echo "Could not determine the source commit." >&2
	exit 1
fi
SOURCE_DIRTY_SHA256="$({
	git -C "${REPO_ROOT}" diff --binary HEAD -- backboard scripts 2>/dev/null || true
	git -C "${REPO_ROOT}" ls-files --others --exclude-standard backboard scripts 2>/dev/null \
		| while IFS= read -r source_path; do
			printf 'untracked %s\n' "${source_path}"
			shasum -a 256 "${REPO_ROOT}/${source_path}" 2>/dev/null || true
		done
} | shasum -a 256 | awk '{ print $1 }')"
BUILT_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

IMAGE_TAG="backboard-linux-builder:node-${NODE_VERSION}-bun-${BUN_VERSION}"
RUN_SUFFIX="$(date +%s)-$$"
SOURCE_VOLUME="backboard-linux-source-${RUN_SUFFIX}"
BUILD_CONTAINER="backboard-linux-build-${RUN_SUFFIX}"
TEMP_PARENT="${REPO_ROOT}/.codex-temp"
mkdir -p "${TEMP_PARENT}"
HOST_STAGE="$(mktemp -d "${TEMP_PARENT}/linux-release.XXXXXX")"
OUTPUT_DIR="${REPO_ROOT}/linux-release/${VERSION}/${ARCH}"

cleanup() {
	"${DOCKER[@]}" rm -f "${BUILD_CONTAINER}" >/dev/null 2>&1 || true
	"${DOCKER[@]}" volume rm "${SOURCE_VOLUME}" >/dev/null 2>&1 || true
	if [[ -n "${HOST_STAGE:-}" && "${HOST_STAGE}" == "${TEMP_PARENT}"/linux-release.* ]]; then
		rm -rf "${HOST_STAGE}"
	fi
}
trap cleanup EXIT INT TERM

echo "Building the reusable Linux x86_64 toolchain image"
"${DOCKER[@]}" build \
	--platform linux/amd64 \
	--progress plain \
	--build-arg "NODE_VERSION=${NODE_VERSION}" \
	--build-arg "BUN_VERSION=${BUN_VERSION}" \
	-t "${IMAGE_TAG}" \
	-f "${REPO_ROOT}/scripts/linux-release/Dockerfile" \
	"${REPO_ROOT}/scripts/linux-release"

"${DOCKER[@]}" volume create "${SOURCE_VOLUME}" >/dev/null
echo "Copying the current tracked and untracked source state into an isolated Docker volume"
(
	cd "${REPO_ROOT}"
	git ls-files -co --exclude-standard -z -- backboard scripts \
		| while IFS= read -r -d '' source_path; do
			# Tracked files deleted in the working tree must not enter the archive.
			if [[ -e "${source_path}" || -L "${source_path}" ]]; then
				printf '%s\0' "${source_path}"
			fi
		done \
		| COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --null -T - -cf -
) | "${DOCKER[@]}" run --rm -i \
	-v "${SOURCE_VOLUME}:/work/source" \
	"${IMAGE_TAG}" \
	tar -xf - -C /work/source

"${DOCKER[@]}" create \
	--name "${BUILD_CONTAINER}" \
	--platform linux/amd64 \
	-e "VERSION=${VERSION}" \
	-e "ARCH=${ARCH}" \
	-e "CHANNEL=${CHANNEL}" \
	-e "BUILD_SOURCEVERSION=${SOURCE_COMMIT}" \
	-e "SOURCE_DIRTY_SHA256=${SOURCE_DIRTY_SHA256}" \
	-e "BUILT_AT=${BUILT_AT}" \
	-e "BUILD_JOBS=${BUILD_JOBS}" \
	-v "${SOURCE_VOLUME}:/work/source" \
	"${IMAGE_TAG}" \
	bash /work/source/scripts/linux-release/build-in-container.sh >/dev/null

echo "Starting the isolated Linux build; this can take a while under x86_64 emulation"
"${DOCKER[@]}" start -a "${BUILD_CONTAINER}"

"${DOCKER[@]}" cp "${BUILD_CONTAINER}:/work/output/." "${HOST_STAGE}/"
for artifact in \
	Backboard-Studio-linux-x86_64.tar.gz \
	Backboard-Studio-linux-x86_64.deb \
	SHA256SUMS; do
	if [[ ! -s "${HOST_STAGE}/${artifact}" ]]; then
		echo "The build completed without expected artifact ${artifact}." >&2
		exit 1
	fi
done

(
	cd "${HOST_STAGE}"
	shasum -a 256 -c SHA256SUMS
)
mkdir -p "${OUTPUT_DIR}"
cp "${HOST_STAGE}/Backboard-Studio-linux-x86_64.tar.gz" "${OUTPUT_DIR}/"
cp "${HOST_STAGE}/Backboard-Studio-linux-x86_64.deb" "${OUTPUT_DIR}/"
cp "${HOST_STAGE}/SHA256SUMS" "${OUTPUT_DIR}/"

echo
echo "Local Linux release completed; no files were uploaded."
echo "Artifacts: ${OUTPUT_DIR}"
ls -lh "${OUTPUT_DIR}/Backboard-Studio-linux-x86_64.tar.gz" \
	"${OUTPUT_DIR}/Backboard-Studio-linux-x86_64.deb" \
	"${OUTPUT_DIR}/SHA256SUMS"
