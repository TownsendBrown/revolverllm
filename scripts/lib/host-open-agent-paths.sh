# Shared paths for the host open agent (Docker web UI folder opens).
# Source from scripts/*.sh:
#   . "$(dirname -- "$0")/lib/host-open-agent-paths.sh"
set -e

_scripts_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$_scripts_dir/.." && pwd)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

export REVOLVER_HOST_AGENT_PORT="${REVOLVER_HOST_AGENT_PORT:-9743}"
export REVOLVER_HOST_AGENT_BIND="${REVOLVER_HOST_AGENT_BIND:-0.0.0.0}"
export REVOLVER_HOST_AGENT_SOCKET="${REVOLVER_HOST_AGENT_SOCKET:-$REPO_ROOT/data/revolver-host-open.sock}"
export HOST_OPEN_AGENT_PID_FILE="${HOST_OPEN_AGENT_PID_FILE:-$REPO_ROOT/data/revolver-host-open-agent.pid}"
export HOST_OPEN_AGENT_LOG_FILE="${HOST_OPEN_AGENT_LOG_FILE:-$REPO_ROOT/data/revolver-host-open-agent.log}"

mkdir -p "$REPO_ROOT/data"
