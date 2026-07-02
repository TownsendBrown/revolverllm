#!/bin/sh
set -e
. "$(dirname -- "$0")/lib/host-open-agent-paths.sh"
. "$(dirname -- "$0")/lib/host-open-agent.sh"

stop_host_open_agent
