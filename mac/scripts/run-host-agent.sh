#!/bin/sh
# Start host agent in foreground (for debugging). docker:up:mac uses ensure-host-agent.sh instead.
set -e
. "$(dirname -- "$0")/lib/paths.sh"
cd "$MAC_ROOT/host-agent"

if [ ! -d node_modules ]; then
  npm install
fi

echo "[mac] host agent foreground — socket=$REVOLVER_LLAMA_SOCKET"
exec npm start
