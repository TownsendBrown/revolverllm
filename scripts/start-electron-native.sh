#!/bin/sh
# Launch Electron with native llama-server (no Docker inference).
# Linux: prefers Revolver CUDA packs under backends/dist or ~/.revolver/backends.
# macOS: use npm run start:macos (Metal).
# Usage: scripts/start-electron-native.sh [--dev]
set -e
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$(uname -s)" = "Darwin" ]; then
  echo "start:native is Linux CUDA packs. On macOS: npm run start:macos" >&2
  exit 1
fi

resolve_llama_bin() {
  if [ -n "${LLAMA_SERVER_BIN:-}" ] && [ -x "$LLAMA_SERVER_BIN" ]; then
    printf '%s\n' "$LLAMA_SERVER_BIN"
    return 0
  fi
  if LINE="$("$REPO_ROOT/backends/lib/resolve.sh" 2>/dev/null)"; then
    BIN=$(printf '%s\n' "$LINE" | cut -f1)
    LIB=$(printf '%s\n' "$LINE" | cut -f2)
    PACK=$(printf '%s\n' "$LINE" | cut -f3)
    if [ -n "$BIN" ] && [ -x "$BIN" ]; then
      if [ -n "$LIB" ] && [ -d "$LIB" ]; then
        export LD_LIBRARY_PATH="$LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
      fi
      if [ -n "$PACK" ]; then
        export REVOLVER_BACKEND_PACK="$PACK"
      fi
      printf '%s\n' "$BIN"
      return 0
    fi
  fi
  HOME_DIR="${HOME:-/root}"
  for cand in \
    "$(command -v llama-server 2>/dev/null || true)" \
    "$(command -v llama-server-cuda 2>/dev/null || true)" \
    "$HOME_DIR/.local/bin/llama-server" \
    /usr/local/bin/llama-server \
    /usr/bin/llama-server
  do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

BIN="$(resolve_llama_bin || true)"
if [ -z "$BIN" ]; then
  echo "llama-server not found." >&2
  echo "  ./backends/build.sh sm70 && npm run install:llama-server" >&2
  echo "  # or: export LLAMA_SERVER_BIN=/path/to/llama-server" >&2
  exit 1
fi

export LLAMA_SERVER_BIN="$BIN"
export REVOLVER_RUNTIME=native
unset REVOLVER_COMPOSE
export LLAMA_HOST="${LLAMA_HOST:-127.0.0.1}"
export LLAMA_CONNECT_HOST="${LLAMA_CONNECT_HOST:-127.0.0.1}"

echo "[native] llama-server: $LLAMA_SERVER_BIN"
if [ -n "${REVOLVER_BACKEND_PACK:-}" ]; then
  echo "[native] backend pack: $REVOLVER_BACKEND_PACK"
fi
echo "[native] REVOLVER_RUNTIME=native (Docker not required for llama.cpp)"

if [ "${1:-}" = "--dev" ]; then
  exec npm run dev
fi

npm run rebuild:native
npm run build
exec env -u ELECTRON_RUN_AS_NODE ELECTRON_NO_SANDBOX=1 electron . --no-sandbox
