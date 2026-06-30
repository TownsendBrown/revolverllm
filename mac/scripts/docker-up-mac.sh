#!/bin/sh
# Mac Metal deployment: host agent (native) + Revolver compose stack.
set -e
. "$(dirname -- "$0")/lib/paths.sh"

case "$(uname -s)" in
  Darwin) ;;
  *)
    echo "docker:up:mac requires macOS (Metal host agent runs on the host)." >&2
    exit 1
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — install Docker Desktop." >&2
  exit 1
fi

if ! command -v llama-server >/dev/null 2>&1 && \
   ! command -v llama-server-metal >/dev/null 2>&1 && \
   [ ! -x "/opt/homebrew/bin/llama-server" ] && \
   [ ! -x "/usr/local/bin/llama-server" ]; then
  echo "[mac] warning: llama-server not found — run mac/scripts/install-llama-server.sh or: brew install llama.cpp" >&2
fi

"$(dirname -- "$0")/ensure-host-agent.sh"

cd "$REPO_ROOT"
export REVOLVER_LLAMA_CONFIG_HOST REVOLVER_LLAMA_SOCKET_HOST MODELS_DIR

echo "[mac] starting compose stack (Metal backend via host agent)"
exec docker compose -f docker-compose.yml -f docker-compose.mac.yml up --build "$@"
