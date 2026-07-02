# Host open agent helpers. Source after host-open-agent-paths.sh:
#   . "$(dirname -- "$0")/lib/host-open-agent-paths.sh"
#   . "$(dirname -- "$0")/lib/host-open-agent.sh"

host_open_agent_ping() {
  REVOLVER_HOST_AGENT_HOST=127.0.0.1 REVOLVER_HOST_AGENT_PORT="$REVOLVER_HOST_AGENT_PORT" \
    node "$REPO_ROOT/host/open-agent/cli.mjs" ping >/dev/null 2>&1
}

port_listener_pids() {
  if command -v fuser >/dev/null 2>&1; then
    fuser "${REVOLVER_HOST_AGENT_PORT}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":${REVOLVER_HOST_AGENT_PORT}" 2>/dev/null || true
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :${REVOLVER_HOST_AGENT_PORT}" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9]*\).*/\1/p' || true
  fi
}

kill_pid_gracefully() {
  pid="$1"
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || return 0
  sleep 0.5
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
}

stop_host_open_agent() {
  stopped=0

  if [ -f "$HOST_OPEN_AGENT_PID_FILE" ]; then
    pid="$(cat "$HOST_OPEN_AGENT_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "[host-open-agent] stopping pid $pid"
      kill_pid_gracefully "$pid"
      stopped=1
    fi
    rm -f "$HOST_OPEN_AGENT_PID_FILE"
  fi

  for pid in $(port_listener_pids); do
    echo "[host-open-agent] stopping port ${REVOLVER_HOST_AGENT_PORT} listener (pid $pid)"
    kill_pid_gracefully "$pid"
    stopped=1
  done

  if [ -e "$REVOLVER_HOST_AGENT_SOCKET" ]; then
    rm -f "$REVOLVER_HOST_AGENT_SOCKET"
    stopped=1
  fi

  if [ "$stopped" -eq 0 ]; then
    echo "[host-open-agent] not running"
  else
    echo "[host-open-agent] stopped"
  fi
}

start_host_open_agent() {
  echo "[host-open-agent] starting (tcp://${REVOLVER_HOST_AGENT_BIND}:${REVOLVER_HOST_AGENT_PORT})"
  (
    cd "$REPO_ROOT"
    export REVOLVER_HOST_AGENT_BIND REVOLVER_HOST_AGENT_PORT REVOLVER_HOST_AGENT_SOCKET
    unset REVOLVER_HOST_AGENT_HOST npm_config_devdir
    nohup node host/open-agent/hostd.mjs >>"$HOST_OPEN_AGENT_LOG_FILE" 2>&1 &
    echo $! >"$HOST_OPEN_AGENT_PID_FILE"
  )
}

ensure_host_open_agent() {
  if host_open_agent_ping; then
    echo "[host-open-agent] already running (pid $(cat "$HOST_OPEN_AGENT_PID_FILE" 2>/dev/null || echo unknown))"
    return 0
  fi

  stop_host_open_agent

  : >"$HOST_OPEN_AGENT_LOG_FILE"
  start_host_open_agent

  deadline=$(( $(date +%s) + 20 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if host_open_agent_ping; then
      echo "[host-open-agent] ready (pid $(cat "$HOST_OPEN_AGENT_PID_FILE"), log=$HOST_OPEN_AGENT_LOG_FILE)"
      return 0
    fi
    if [ -f "$HOST_OPEN_AGENT_PID_FILE" ]; then
      pid="$(cat "$HOST_OPEN_AGENT_PID_FILE" 2>/dev/null || true)"
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
        echo "[host-open-agent] process exited — see $HOST_OPEN_AGENT_LOG_FILE" >&2
        tail -n 20 "$HOST_OPEN_AGENT_LOG_FILE" 2>/dev/null >&2 || true
        return 1
      fi
    fi
    sleep 0.5
  done

  echo "[host-open-agent] failed to start — see $HOST_OPEN_AGENT_LOG_FILE" >&2
  tail -n 20 "$HOST_OPEN_AGENT_LOG_FILE" 2>/dev/null >&2 || true
  return 1
}
