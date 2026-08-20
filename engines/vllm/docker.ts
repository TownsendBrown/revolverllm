import { LOAD_ENV_FILE_SH } from "../../shared/loadEnvFile";

/** Port vLLM OpenAI server listens on inside the container. */
export const VLLM_CONTAINER_PORT = 8000;

export const VLLM_ENTRYPOINT_FILE = "vllm-entrypoint.sh";

export function vllmEnvFileName(serverId: string): string {
  return `vllm-load-${serverId}.env`;
}

export function vllmImage(): string {
  return process.env.VLLM_IMAGE ?? "vllm/vllm-openai:latest";
}

/** Embedded entrypoint: sources per-server env and execs the OpenAI-compatible API server. */
export const VLLM_ENTRYPOINT_SCRIPT = `#!/bin/sh
set -e

${LOAD_ENV_FILE_SH}

CONFIG_DIR="\${VLLM_CONFIG_DIR:-/config}"
ENV_FILE="\${VLLM_ENV_FILE:-vllm-load.env}"
ENV_PATH="$CONFIG_DIR/$ENV_FILE"

HOST="0.0.0.0"
PORT="\${VLLM_PORT:-8000}"
MODEL=""
MAX_MODEL_LEN=""
TENSOR_PARALLEL=""
GPU_MEM_UTIL=""
DTYPE=""
QUANTIZATION=""
TOKENIZER=""
TOKENIZER_MODE=""
ENFORCE_EAGER=""
API_KEY=""

if [ -f "$ENV_PATH" ]; then
  load_env_file "$ENV_PATH"
  MODEL="\${MODEL:-}"
  HOST="\${VLLM_HOST:-0.0.0.0}"
  PORT="\${VLLM_PORT:-8000}"
  MAX_MODEL_LEN="\${MAX_MODEL_LEN:-}"
  TENSOR_PARALLEL="\${TENSOR_PARALLEL_SIZE:-}"
  GPU_MEM_UTIL="\${GPU_MEMORY_UTILIZATION:-}"
  DTYPE="\${DTYPE:-}"
  QUANTIZATION="\${QUANTIZATION:-}"
  TOKENIZER="\${TOKENIZER:-}"
  TOKENIZER_MODE="\${TOKENIZER_MODE:-}"
  ENFORCE_EAGER="\${ENFORCE_EAGER:-}"
  API_KEY="\${API_KEY:-}"
fi

[ -n "\${CUDA_VISIBLE_DEVICES:-}" ] && export CUDA_VISIBLE_DEVICES

case "$MODEL" in
  "" | undefined | null) MODEL="" ;;
esac

if [ -z "$MODEL" ]; then
  echo "vllm: no model configured — idle (load via Revolver backend)"
  exec sleep infinity
fi

set -- python3 -m vllm.entrypoints.openai.api_server --model "$MODEL" --host "$HOST" --port "$PORT"
[ -n "$TOKENIZER" ] && set -- "$@" --tokenizer "$TOKENIZER"
[ -n "$TOKENIZER_MODE" ] && set -- "$@" --tokenizer-mode "$TOKENIZER_MODE"
[ -n "$MAX_MODEL_LEN" ] && set -- "$@" --max-model-len "$MAX_MODEL_LEN"
[ -n "$TENSOR_PARALLEL" ] && [ "$TENSOR_PARALLEL" -gt 0 ] && set -- "$@" --tensor-parallel-size "$TENSOR_PARALLEL"
[ -n "$GPU_MEM_UTIL" ] && set -- "$@" --gpu-memory-utilization "$GPU_MEM_UTIL"
[ -n "$DTYPE" ] && [ "$DTYPE" != "auto" ] && set -- "$@" --dtype "$DTYPE"
[ -n "$QUANTIZATION" ] && [ "$QUANTIZATION" != "auto" ] && set -- "$@" --quantization "$QUANTIZATION"
[ -n "$ENFORCE_EAGER" ] && case "$ENFORCE_EAGER" in 1 | true | yes | on) set -- "$@" --enforce-eager ;; esac
[ -n "$API_KEY" ] && set -- "$@" --api-key "$API_KEY"

echo "vllm starting: model=$MODEL host=$HOST port=$PORT tp=\${TENSOR_PARALLEL:-1} max_len=\${MAX_MODEL_LEN:-default}"

exec "$@"
`;
