#!/usr/bin/env bash
# Build the Linux CUDA backend pack (one fat SKU).
# Usage:
#   ./backends/build.sh linux-cuda
#   ./backends/build.sh linux-cuda --docker
set -euo pipefail

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  echo "Usage: backends/build.sh [linux-cuda|cuda] [--docker]" >&2
  echo "Linux Electron only. macOS Metal: mac/scripts/install-llama-server.sh" >&2
  exit 2
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
fi

ALIAS="${1:-linux-cuda}"
if [ -n "${1:-}" ]; then
  shift
fi
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
  linux-cuda|cuda|"") PACK_ID=linux-cuda ; SCRIPT=linux/cuda/build.sh ;;
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
