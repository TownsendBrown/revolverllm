#!/usr/bin/env bash
# CUDA 12 fat pack (Turing–Hopper) — Linux Electron. One SKU, LMS-style.
set -euo pipefail
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
export REPO_ROOT
export PACK_ID="${PACK_ID:-linux-cuda}"
export CATALOG="${CATALOG:-$REPO_ROOT/backends/catalog.json}"
# Portable AVX2, not -march=native (GitHub-release binary).
export GGML_NATIVE="${GGML_NATIVE:-OFF}"
# shellcheck source=../../lib/common.sh
. "$REPO_ROOT/backends/lib/common.sh"

if [ "${1:-}" = "--docker" ]; then
  run_docker_build
  exit 0
fi

if [ "$(uname -s)" = "Darwin" ]; then
  echo "linux-cuda is a Linux pack. macOS: mac/scripts/install-llama-server.sh" >&2
  exit 1
fi

build_cuda_pack
