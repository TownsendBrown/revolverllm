#!/usr/bin/env bash
# Build one Linux CUDA backend pack.
# Usage:
#   ./backends/build.sh sm70
#   ./backends/build.sh pascal
#   ./backends/build.sh linux-cuda-sm70 --docker
set -euo pipefail

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  echo "Usage: backends/build.sh <sm70|pascal|linux-cuda-sm70|linux-cuda-pascal> [--docker]" >&2
  echo "Linux Electron only. macOS Metal: mac/scripts/install-llama-server.sh" >&2
  exit 2
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ -z "${1:-}" ]; then
  usage
fi

ALIAS="$1"
shift
DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --docker) DOCKER=1 ;;
    -h|--help) usage ;;
    *)
      echo "unknown arg: $arg" >&2
      usage
      ;;
  esac
done

case "$ALIAS" in
  sm70|sm_70|volta|v100|linux-cuda-sm70) PACK_ID=linux-cuda-sm70 ; SCRIPT=linux/cuda-sm70/build.sh ;;
  pascal|sm60|sm_60|sm61|sm_61|p100|linux-cuda-pascal) PACK_ID=linux-cuda-pascal ; SCRIPT=linux/cuda-pascal/build.sh ;;
  *)
    echo "unknown pack: $ALIAS" >&2
    usage
    ;;
esac

if [ "$(uname -s)" = "Darwin" ] && [ "$DOCKER" != "1" ]; then
  echo "CUDA backend packs are Linux-only. On macOS use: npm run start:macos" >&2
  exit 1
fi

export PACK_ID
if [ "$DOCKER" = "1" ]; then
  exec "$REPO_ROOT/backends/$SCRIPT" --docker
fi
exec "$REPO_ROOT/backends/$SCRIPT"
