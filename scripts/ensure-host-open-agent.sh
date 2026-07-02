#!/bin/sh
# Start host open agent in background if not already running. Idempotent.
set -e
. "$(dirname -- "$0")/lib/host-open-agent-paths.sh"
. "$(dirname -- "$0")/lib/host-open-agent.sh"

ensure_host_open_agent
