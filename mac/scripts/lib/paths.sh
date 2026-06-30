# Shared paths for mac Metal stack. Source from mac/scripts/*.sh:
#   . "$(dirname -- "$0")/lib/paths.sh"
set -e

# When sourced, $0 is the caller script (e.g. ensure-host-agent.sh in mac/scripts/).
_scripts_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MAC_ROOT="$(CDPATH= cd -- "$_scripts_dir/.." && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$MAC_ROOT/.." && pwd)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

export LLAMA_CONFIG_DIR="${LLAMA_CONFIG_DIR:-$REPO_ROOT/data/llama-config}"
export MODELS_HOST_DIR="${MODELS_HOST_DIR:-${MODELS_DIR:-$REPO_ROOT/models}}"
export REVOLVER_LLAMA_PORT="${REVOLVER_LLAMA_PORT:-9742}"
export REVOLVER_LLAMA_BIND="${REVOLVER_LLAMA_BIND:-0.0.0.0}"
export REVOLVER_LLAMA_SOCKET="${REVOLVER_LLAMA_SOCKET:-$REPO_ROOT/data/revolver-llama.sock}"
export REVOLVER_LLAMA_CONFIG_HOST="${REVOLVER_LLAMA_CONFIG_HOST:-$REPO_ROOT/data/llama-config}"
export REVOLVER_LLAMA_SOCKET_HOST="${REVOLVER_LLAMA_SOCKET_HOST:-$REPO_ROOT/data/revolver-llama.sock}"
export HOST_AGENT_PID_FILE="${HOST_AGENT_PID_FILE:-$REPO_ROOT/data/revolver-host-agent.pid}"
export HOST_AGENT_LOG_FILE="${HOST_AGENT_LOG_FILE:-$REPO_ROOT/data/revolver-host-agent.log}"

mkdir -p "$(dirname "$REVOLVER_LLAMA_SOCKET")" "$LLAMA_CONFIG_DIR"
