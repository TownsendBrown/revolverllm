#!/usr/bin/env bash
# Tar / hash a Linux llama.cpp SKU and print a runtimes/catalog.json snippet.
# Upload onto the existing TownsendBrown/revolverllm runtimes-v1 release
# (same bucket as Metal / MLX). Do not create a second release page.
#
# Usage:
#   scripts/pack-linux-runtime.sh linux-cuda
#   scripts/pack-linux-runtime.sh linux-vulkan [path-or-url]
#   scripts/pack-linux-runtime.sh linux-cpu [path-or-url]
#
# CUDA tars backends/dist/linux-cuda/ (bin/ + lib/).
# vulkan/cpu: pass a ggml ubuntu tarball, or omit to download from ggml-org.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="${1:-}"
SRC="${2:-}"
RELEASE_TAG="${RUNTIMES_RELEASE_TAG:-runtimes-v1}"
REPO="${RUNTIMES_REPO:-TownsendBrown/revolverllm}"
OUT_DIR="${ROOT}/build"

GGML_TAG="${GGML_TAG:-b10453}"
TAG=""

log() { printf '[pack-linux-runtime] %s\n' "$*"; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

size_file() {
  wc -c < "$1" | tr -d ' '
}

usage() {
  echo "usage: $0 linux-cuda|linux-vulkan|linux-cpu [source]" >&2
  exit 1
}

case "$ID" in
  linux-cuda)
    ASSET="linux-cuda-${GGML_TAG}.tar.gz"
    LABEL="CUDA llama.cpp"
    BACKEND="cuda"
    UNPACK="."
    BINARY="bin/llama-server"
    LIBDIR="lib"
    TAG="${GGML_TAG}"
    ;;
  linux-vulkan)
    ASSET="llama-${GGML_TAG}-bin-ubuntu-vulkan-x64.tar.gz"
    LABEL="Vulkan llama.cpp"
    BACKEND="vulkan"
    UNPACK="llama-${GGML_TAG}"
    BINARY="llama-server"
    LIBDIR=""
    TAG="${GGML_TAG}"
    GGML_URL="https://github.com/ggml-org/llama.cpp/releases/download/${GGML_TAG}/${ASSET}"
    ;;
  linux-cpu)
    ASSET="llama-${GGML_TAG}-bin-ubuntu-x64.tar.gz"
    LABEL="CPU llama.cpp"
    BACKEND="cpu"
    UNPACK="llama-${GGML_TAG}"
    BINARY="llama-server"
    LIBDIR=""
    TAG="${GGML_TAG}"
    GGML_URL="https://github.com/ggml-org/llama.cpp/releases/download/${GGML_TAG}/${ASSET}"
    ;;
  *)
    usage
    ;;
esac

mkdir -p "${OUT_DIR}"
ARCHIVE_PATH="${OUT_DIR}/${ASSET}"

if [[ "$ID" == linux-cuda ]]; then
  PACK_DIR="${SRC:-${ROOT}/backends/dist/${ID}}"
  if [[ ! -d "${PACK_DIR}" ]]; then
    echo "missing pack dir ${PACK_DIR} — build with ./backends/build.sh linux-cuda first" >&2
    exit 1
  fi
  if [[ ! -x "${PACK_DIR}/bin/llama-server" && ! -x "${PACK_DIR}/bin/llama-server.exe" ]]; then
    echo "no llama-server in ${PACK_DIR}/bin" >&2
    exit 1
  fi
  log "tarring ${PACK_DIR} → ${ARCHIVE_PATH}"
  tar -czf "${ARCHIVE_PATH}" -C "${PACK_DIR}" .
else
  if [[ -n "${SRC}" && -f "${SRC}" ]]; then
    log "copying ${SRC} → ${ARCHIVE_PATH}"
    cp "${SRC}" "${ARCHIVE_PATH}"
  elif [[ -n "${SRC}" && "${SRC}" == http* ]]; then
    log "downloading ${SRC}"
    curl -fsSL -o "${ARCHIVE_PATH}" "${SRC}"
  else
    log "downloading ${GGML_URL}"
    curl -fsSL -o "${ARCHIVE_PATH}" "${GGML_URL}"
  fi
fi

SHA256="$(sha256_file "${ARCHIVE_PATH}")"
SIZE_BYTES="$(size_file "${ARCHIVE_PATH}")"
URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET}"

LIB_LINE=""
if [[ -n "${LIBDIR}" ]]; then
  LIB_LINE=",
      \"libDir\": \"${LIBDIR}\""
fi

echo
echo "Archive:"
echo "  ${ARCHIVE_PATH}"
echo "  sha256:  ${SHA256}"
echo "  size:    ${SIZE_BYTES} bytes"
echo
echo "Catalog snippet (paste into runtimes/catalog.json linux.${ID}):"
echo "    \"${ID}\": {"
echo "      \"label\": \"${LABEL}\","
echo "      \"backend\": \"${BACKEND}\","
cat <<EOF
      "tag": "${TAG}",
      "asset": "${ASSET}",
      "url": "${URL}",
      "sha256": "${SHA256}",
      "sizeBytes": ${SIZE_BYTES},
      "unpackDir": "${UNPACK}",
      "binary": "${BINARY}"${LIB_LINE}
    }

Host deps (do not bundle): NVIDIA driver for CUDA SKU; Mesa + video/render + /dev/dri for Vulkan.

Upload with:
  gh release upload ${RELEASE_TAG} --repo ${REPO} "${ARCHIVE_PATH}"
EOF
