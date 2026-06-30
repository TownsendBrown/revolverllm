#!/bin/sh
# Stop background host agent started by ensure-host-agent.sh
set -e
. "$(dirname -- "$0")/lib/paths.sh"

if [ ! -f "$HOST_AGENT_PID_FILE" ]; then
  echo "[mac] host agent not running (no pid file)"
  rm -f "$REVOLVER_LLAMA_SOCKET"
  exit 0
fi

pid="$(cat "$HOST_AGENT_PID_FILE" 2>/dev/null || true)"
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  echo "[mac] stopping host agent (pid $pid)"
  kill "$pid" 2>/dev/null || true
  sleep 0.5
  kill -9 "$pid" 2>/dev/null || true
else
  echo "[mac] host agent pid $pid not running"
fi

rm -f "$HOST_AGENT_PID_FILE" "$REVOLVER_LLAMA_SOCKET"
echo "[mac] host agent stopped"
