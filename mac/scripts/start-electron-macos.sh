#!/bin/sh
# Electron on macOS — native Metal via host agent; no Docker CUDA/ROCm/Vulkan backends.
set -e
. "$(dirname -- "$0")/lib/paths.sh"

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "start:macos requires macOS (Metal host agent runs on the host)." >&2
    exit 1
    ;;
esac

if ! command -v llama-server >/dev/null 2>&1 && \
   ! command -v llama-server-metal >/dev/null 2>&1 && \
   [ ! -x "/opt/homebrew/bin/llama-server" ] && \
   [ ! -x "/usr/local/bin/llama-server" ]; then
  echo "[mac] warning: llama-server not found — run mac/scripts/install-llama-server.sh or: brew install llama.cpp" >&2
fi

# Align host-agent model dir with Electron macOS layout (before agent start).
MAC_MODELS_ROOT="${HOME}/Library/Application Support/Revolver"
export MODELS_HOST_DIR="${MODELS_HOST_DIR:-${MODELS_DIR:-${MAC_MODELS_ROOT}/models}}"
export MODELS_DIR="$MODELS_HOST_DIR"
mkdir -p "$MODELS_HOST_DIR" "${MAC_MODELS_ROOT}/hub/models" "$MAC_MODELS_ROOT/.internal"

"$(dirname -- "$0")/ensure-host-agent.sh"

cd "$REPO_ROOT"

export REVOLVER_LLAMA_HOST=127.0.0.1
export REVOLVER_LLAMA_PORT="${REVOLVER_LLAMA_PORT:-9742}"
export LLAMA_GPU=0
export LLAMA_CONFIG_HOST_DIR="${REVOLVER_LLAMA_CONFIG_HOST:-$LLAMA_CONFIG_DIR}"
unset REVOLVER_LLAMA_SOCKET

echo "[mac] starting Electron (Metal + CPU backends only)"
npm run rebuild:native
npm run build
exec env -u ELECTRON_RUN_AS_NODE ELECTRON_NO_SANDBOX=1 electron .
