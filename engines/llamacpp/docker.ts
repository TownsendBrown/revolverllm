import { LOAD_ENV_FILE_SH } from "../../shared/loadEnvFile";
import type { InferenceBackend } from "../../shared/types";

/** Port llama-server listens on inside the container. */
export const LLAMA_CONTAINER_PORT = 8080;

export const LLAMA_ENTRYPOINT_FILE = "entrypoint.sh";

export function llamaEnvFileName(serverId: string): string {
  return `llama-load-${serverId}.env`;
}

/**
 * Public llama.cpp images per backend. We run these directly and inject our
 * own entrypoint via the shared config volume, so the backend container does
 * not need any Docker build context (which the host daemon couldn't see anyway).
 */
export function llamaImage(backend: InferenceBackend): string {
  const override = process.env[`LLAMA_IMAGE_${backend.toUpperCase()}`];
  if (override) return override;
  switch (backend) {
    case "cuda":
      return "ghcr.io/ggml-org/llama.cpp:server-cuda";
    case "rocm":
      return "ghcr.io/ggml-org/llama.cpp:server-rocm";
    case "vulkan":
      return "ghcr.io/ggml-org/llama.cpp:server-vulkan";
    default:
      return "ghcr.io/ggml-org/llama.cpp:server";
  }
}

/** Embedded so it works in both Electron and compose-backend modes without a build context. */
export const LLAMA_ENTRYPOINT_SCRIPT = `#!/bin/sh
set -e

${LOAD_ENV_FILE_SH}

CONFIG_DIR="\${LLAMA_CONFIG_DIR:-/config}"
ENV_FILE="\${LLAMA_ENV_FILE:-llama-load.env}"
ENV_PATH="$CONFIG_DIR/$ENV_FILE"

HOST="0.0.0.0"
PORT="\${LLAMA_PORT:-8080}"
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
BACKEND="\${BACKEND:-cpu}"

if [ -f "$ENV_PATH" ]; then
  load_env_file "$ENV_PATH"
  MODEL="\${MODEL_PATH:-}"
  CTX="\${CTX_SIZE:-}"
  GPU_LAYERS="\${N_GPU_LAYERS:-}"
  MMPROJ="\${MMPROJ_PATH:-}"
  FLASH="\${FLASH_ATTN:-}"
  CACHE_K="\${CACHE_TYPE_K:-}"
  CACHE_V="\${CACHE_TYPE_V:-}"
  N_PARALLEL="\${N_PARALLEL:-}"
  REASONING="\${REASONING:-}"
  REASONING_FORMAT="\${REASONING_FORMAT:-}"
  KV_UNIFIED="\${KV_UNIFIED:-}"
  API_KEY="\${API_KEY:-}"
  HOST="\${LLAMA_HOST:-0.0.0.0}"
  PORT="\${LLAMA_PORT:-8080}"
  BACKEND="\${BACKEND:-cpu}"
fi

[ -n "\${CUDA_VISIBLE_DEVICES:-}" ] && export CUDA_VISIBLE_DEVICES
[ -n "\${HIP_VISIBLE_DEVICES:-}" ] && export HIP_VISIBLE_DEVICES
[ -n "\${ROCR_VISIBLE_DEVICES:-}" ] && export ROCR_VISIBLE_DEVICES
[ -n "\${GGML_VK_VISIBLE_DEVICES:-}" ] && export GGML_VK_VISIBLE_DEVICES
[ -n "\${VK_ICD_FILENAMES:-}" ] && export VK_ICD_FILENAMES
[ -n "\${VK_LOADER_DRIVERS_DISABLE:-}" ] && export VK_LOADER_DRIVERS_DISABLE

case "$MODEL" in
  "" | undefined | null) MODEL="" ;;
esac

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  if [ -n "$MODEL" ]; then
    echo "llama-server: model file not found: $MODEL — idle (load via Revolver backend)"
  else
    echo "llama-server: no model configured — idle (load via Revolver backend)"
  fi
  # Native supervisor must not leave a sleep-infinity process around.
  if [ "\${LLAMA_NATIVE:-}" = "1" ]; then
    exit 0
  fi
  exec sleep infinity
fi

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
# Jinja chat templates enable OpenAI-style tool calling (agency benchmark).
# Opt out with JINJA=off for models whose templates misbehave.
case "\${JINJA:-on}" in
  0 | off | false | no) ;;
  *) set -- "$@" --jinja ;;
esac

echo "llama-server starting: backend=$BACKEND model=$MODEL ctx=\${CTX:-default} gpu_layers=\${GPU_LAYERS:-0} flash_attn=\${FLASH:-default} kv=\${CACHE_K:-f16} parallel=\${N_PARALLEL:-auto} reasoning=\${REASONING:-auto} reasoning_format=\${REASONING_FORMAT:-auto} kv_unified=\${KV_UNIFIED:-default}"

LLAMA_BIN="\${LLAMA_SERVER_BIN:-}"
if [ -z "$LLAMA_BIN" ]; then
  for cand in /app/llama-server /llama-server "$(command -v llama-server 2>/dev/null)" "$(command -v llama-server-cuda 2>/dev/null)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then LLAMA_BIN="$cand"; break; fi
  done
fi
if [ -z "$LLAMA_BIN" ] || [ ! -x "$LLAMA_BIN" ]; then
  echo "llama-server binary not found (set LLAMA_SERVER_BIN)" >&2
  exit 127
fi
exec "$LLAMA_BIN" "$@"
`;
