#!/bin/sh
# Start macOS host agent in background if not already running. Idempotent.
set -e
. "$(dirname -- "$0")/lib/paths.sh"

HOST_AGENT_DIR="$MAC_ROOT/host-agent"

host_agent_ping() {
  (
    cd "$HOST_AGENT_DIR"
    REVOLVER_LLAMA_HOST=127.0.0.1 REVOLVER_LLAMA_PORT="$REVOLVER_LLAMA_PORT" \
      unset REVOLVER_LLAMA_SOCKET npm_config_devdir
    npm run cli -- ping >/dev/null 2>&1
  )
}

pid_alive() {
  [ -f "$HOST_AGENT_PID_FILE" ] || return 1
  pid="$(cat "$HOST_AGENT_PID_FILE" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

if host_agent_ping; then
  echo "[mac] host agent already running ($(cat "$HOST_AGENT_PID_FILE" 2>/dev/null || echo unknown pid))"
  exit 0
fi

if pid_alive; then
  echo "[mac] stopping stale host agent (pid $(cat "$HOST_AGENT_PID_FILE"))"
  kill "$(cat "$HOST_AGENT_PID_FILE")" 2>/dev/null || true
  sleep 0.5
fi

if [ -e "$REVOLVER_LLAMA_SOCKET" ]; then
  rm -f "$REVOLVER_LLAMA_SOCKET"
fi

if [ ! -d "$HOST_AGENT_DIR/node_modules" ]; then
  echo "[mac] installing host-agent dependencies…"
  (cd "$HOST_AGENT_DIR" && npm install --omit=dev)
fi

echo "[mac] starting host agent (tcp://${REVOLVER_LLAMA_BIND:-0.0.0.0}:${REVOLVER_LLAMA_PORT})"
(
  cd "$HOST_AGENT_DIR"
  export REVOLVER_LLAMA_BIND REVOLVER_LLAMA_PORT LLAMA_CONFIG_DIR MODELS_HOST_DIR
  unset REVOLVER_LLAMA_SOCKET npm_config_devdir
  nohup node --import tsx src/hostd.ts >>"$HOST_AGENT_LOG_FILE" 2>&1 &
  echo $! >"$HOST_AGENT_PID_FILE"
)

deadline=$(( $(date +%s) + 20 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if host_agent_ping; then
    echo "[mac] host agent ready (pid $(cat "$HOST_AGENT_PID_FILE"), log=$HOST_AGENT_LOG_FILE)"
    exit 0
  fi
  sleep 0.5
done

echo "[mac] host agent failed to start — see $HOST_AGENT_LOG_FILE" >&2
tail -n 20 "$HOST_AGENT_LOG_FILE" 2>/dev/null >&2 || true
exit 1
