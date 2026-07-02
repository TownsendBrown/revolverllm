#!/bin/sh
# Start host open agent in foreground (debug).
set -e
. "$(dirname -- "$0")/lib/host-open-agent-paths.sh"
cd "$REPO_ROOT"
export REVOLVER_HOST_AGENT_BIND REVOLVER_HOST_AGENT_PORT REVOLVER_HOST_AGENT_SOCKET
unset REVOLVER_HOST_AGENT_HOST
exec node host/open-agent/hostd.mjs
