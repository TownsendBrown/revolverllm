#!/usr/bin/env bash
# CUDA Pascal sm_60/sm_61 (P100, P40, GTX 10-series) — Linux Electron.
set -euo pipefail
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
export REPO_ROOT
export PACK_ID="${PACK_ID:-linux-cuda-pascal}"
export CATALOG="${CATALOG:-$REPO_ROOT/backends/catalog.json}"
# shellcheck source=../../lib/common.sh
. "$REPO_ROOT/backends/lib/common.sh"

if [ "${1:-}" = "--docker" ]; then
  run_docker_build
  exit 0
fi

if [ "$(uname -s)" = "Darwin" ]; then
  echo "linux-cuda-pascal is a Linux pack. macOS: mac/scripts/install-llama-server.sh" >&2
  exit 1
fi

build_cuda_pack
