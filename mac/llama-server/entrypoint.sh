#!/bin/sh
# Launch llama-server on macOS with Metal (default when built for Darwin).
# Reads load config from LLAMA_CONFIG_DIR / LLAMA_ENV_FILE — same contract as Revolver containers.
set -e

# Assign KEY=VALUE without word-splitting (macOS "Application Support" paths).
load_env_file() {
  [ -f "$1" ] || return 0
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      ""|"#"*) continue ;;
    esac
    _key="${_line%%=*}"
    _val="${_line#*=}"
    _q1="${_val%"${_val#?}"}"
    _q2="${_val#"${_val%?}"}"
    if [ "$_q1" = "$_q2" ] && { [ "$_q1" = '"' ] || [ "$_q1" = "'" ]; }; then
      _val="${_val#?}"
      _val="${_val%?}"
    fi
    case "$_key" in
      ""|*[!A-Za-z0-9_]*) continue ;;
    esac
    export "$_key=$_val"
  done < "$1"
  unset _line _key _val _q1 _q2
}

CONFIG_DIR="${LLAMA_CONFIG_DIR:-./config}"
ENV_FILE="${LLAMA_ENV_FILE:-llama-load.env}"
ENV_PATH="$CONFIG_DIR/$ENV_FILE"

HOST="${LLAMA_HOST:-0.0.0.0}"
PORT="${LLAMA_PORT:-8080}"
BIND_PORT="${LLAMA_PORT:-}"
MODEL=""
CTX=""
GPU_LAYERS=""
MMPROJ=""
FLASH=""
CACHE_K=""
CACHE_V=""
N_PARALLEL=""
REASONING=""
REASONING_FORMAT=""
KV_UNIFIED=""
API_KEY=""
BACKEND="${BACKEND:-metal}"

if [ -f "$ENV_PATH" ]; then
  load_env_file "$ENV_PATH"
  MODEL="${MODEL_PATH:-}"
  CTX="${CTX_SIZE:-}"
  GPU_LAYERS="${N_GPU_LAYERS:-}"
  MMPROJ="${MMPROJ_PATH:-}"
  FLASH="${FLASH_ATTN:-}"
  CACHE_K="${CACHE_TYPE_K:-}"
  CACHE_V="${CACHE_TYPE_V:-}"
  N_PARALLEL="${N_PARALLEL:-}"
  REASONING="${REASONING:-}"
  REASONING_FORMAT="${REASONING_FORMAT:-}"
  KV_UNIFIED="${KV_UNIFIED:-}"
  API_KEY="${API_KEY:-}"
  HOST="${LLAMA_HOST:-0.0.0.0}"
  PORT="${LLAMA_PORT:-8080}"
  BACKEND="${BACKEND:-metal}"
fi

# Host-agent passes the host-facing port; env file keeps container-style 8080.
if [ -n "$BIND_PORT" ]; then
  PORT="$BIND_PORT"
fi

# Map /models/... (container path) → host models root when running on macOS host.
MODELS_HOST="${MODELS_HOST_DIR:-}"
if [ -n "$MODELS_HOST" ] && [ -n "$MODEL" ]; then
  case "$MODEL" in
    /models/*)
      MODEL="$MODELS_HOST${MODEL#/models}"
      ;;
  esac
fi
if [ -n "$MODELS_HOST" ] && [ -n "$MMPROJ" ]; then
  case "$MMPROJ" in
    /models/*)
      MMPROJ="$MODELS_HOST${MMPROJ#/models}"
      ;;
  esac
fi

case "$MODEL" in
  "" | undefined | null) MODEL="" ;;
esac

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  if [ -n "$MODEL" ]; then
    echo "llama-server: model file not found: $MODEL — idle (load via Revolver)"
  else
    echo "llama-server: no model configured — idle (load via Revolver)"
  fi
  exit 0
fi

# Metal on Apple Silicon: offload all layers unless explicitly set.
if [ -z "$GPU_LAYERS" ] || [ "$GPU_LAYERS" = "0" ]; then
  if [ "$BACKEND" = "metal" ]; then
    GPU_LAYERS="-1"
  fi
fi

set -- --host "$HOST" --port "$PORT" --model "$MODEL"
[ -n "$CTX" ] && set -- "$@" --ctx-size "$CTX"
[ -n "$GPU_LAYERS" ] && set -- "$@" --n-gpu-layers "$GPU_LAYERS"
[ -n "$MMPROJ" ] && set -- "$@" --mmproj "$MMPROJ"
[ -n "$FLASH" ] && set -- "$@" --flash-attn "$FLASH"
[ -n "$CACHE_K" ] && set -- "$@" --cache-type-k "$CACHE_K"
[ -n "$CACHE_V" ] && set -- "$@" --cache-type-v "$CACHE_V"
[ -n "$N_PARALLEL" ] && set -- "$@" --parallel "$N_PARALLEL"
[ -n "$REASONING" ] && set -- "$@" --reasoning "$REASONING"
[ -n "$REASONING_FORMAT" ] && set -- "$@" --reasoning-format "$REASONING_FORMAT"
[ -n "$API_KEY" ] && set -- "$@" --api-key "$API_KEY"
case "$KV_UNIFIED" in
  1 | on | true | yes) set -- "$@" --kv-unified ;;
esac

echo "llama-server starting: backend=$BACKEND model=$MODEL ctx=${CTX:-default} gpu_layers=${GPU_LAYERS:-default} port=$PORT"

LLAMA_BIN="${LLAMA_SERVER_BIN:-}"
if [ -z "$LLAMA_BIN" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  for cand in \
    "$(command -v llama-server 2>/dev/null)" \
    "$(command -v llama-server-metal 2>/dev/null)" \
    "/opt/homebrew/bin/llama-server" \
    "/usr/local/bin/llama-server" \
    "$SCRIPT_DIR/bin/llama-server"
  do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      LLAMA_BIN="$cand"
      break
    fi
  done
fi

if [ -z "$LLAMA_BIN" ] || [ ! -x "$LLAMA_BIN" ]; then
  echo "llama-server binary not found. Install: brew install llama.cpp" >&2
  echo "Or set LLAMA_SERVER_BIN to your Metal-enabled llama-server path." >&2
  exit 127
fi

exec "$LLAMA_BIN" "$@"
