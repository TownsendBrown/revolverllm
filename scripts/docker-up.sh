#!/bin/sh
# Start host open agent, then docker compose (needed for open-folder from web UI).
set -e
REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export REVOLVER_HOST_ROOT="${REVOLVER_HOST_ROOT:-$REPO_ROOT}"
"$REPO_ROOT/scripts/ensure-host-open-agent.sh"
cd "$REPO_ROOT"
exec docker compose "$@"
