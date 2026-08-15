#!/usr/bin/env bash
# CUDA Volta sm_70 (Tesla V100 / TITAN V / Quadro GV100) — Linux Electron.
set -euo pipefail
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
export REPO_ROOT
export PACK_ID="${PACK_ID:-linux-cuda-sm70}"
export CATALOG="${CATALOG:-$REPO_ROOT/backends/catalog.json}"
# shellcheck source=../../lib/common.sh
. "$REPO_ROOT/backends/lib/common.sh"

if [ "${1:-}" = "--docker" ]; then
  run_docker_build
  exit 0
fi

if [ "$(uname -s)" = "Darwin" ]; then
  echo "linux-cuda-sm70 is a Linux pack. macOS: mac/scripts/install-llama-server.sh" >&2
  exit 1
fi

build_cuda_pack
