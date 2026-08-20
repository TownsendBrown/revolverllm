import { LOAD_ENV_FILE_SH } from "../../shared/loadEnvFile";

/** Port legacy vLLM OpenAI server listens on inside the container. */
export const VLLM_LEGACY_CONTAINER_PORT = 8000;

export const VLLM_LEGACY_ENTRYPOINT_FILE = "vllm-legacy-entrypoint.sh";

export function vllmLegacyEnvFileName(serverId: string): string {
  return `vllm-legacy-load-${serverId}.env`;
}

export function vllmLegacyImage(): string {
  return process.env.VLLM_LEGACY_IMAGE ?? "revolver/vllm-pascal:0.9.1";
}

/**
 * Entrypoint for sasha0552 vLLM on Pascal — safetensors only. Uses system
 * python3, enforces eager mode, defaults to --dtype half (FP16). Gemma 2 is
 * forced to float32 by the load-env builder (no BF16 on Pascal).
 */
export const VLLM_LEGACY_ENTRYPOINT_SCRIPT = `#!/bin/sh
set -e

${LOAD_ENV_FILE_SH}

CONFIG_DIR="\${VLLM_CONFIG_DIR:-/config}"
ENV_FILE="\${VLLM_ENV_FILE:-vllm-legacy-load.env}"
ENV_PATH="$CONFIG_DIR/$ENV_FILE"

HOST="0.0.0.0"
PORT="\${VLLM_PORT:-8000}"
MODEL=""
MAX_MODEL_LEN=""
TENSOR_PARALLEL=""
GPU_MEM_UTIL=""
DTYPE=""
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
  TOKENIZER="\${TOKENIZER:-}"
  TOKENIZER_MODE="\${TOKENIZER_MODE:-}"
  ENFORCE_EAGER="\${ENFORCE_EAGER:-}"
  API_KEY="\${API_KEY:-}"
fi

# Default FP16 for safetensors when unset.
if [ -z "$DTYPE" ]; then
  DTYPE="half"
fi

[ -n "\${CUDA_VISIBLE_DEVICES:-}" ] && export CUDA_VISIBLE_DEVICES

case "$MODEL" in
  "" | undefined | null) MODEL="" ;;
esac

if [ -z "$MODEL" ]; then
  echo "vllm-legacy: no model configured — idle (load via Revolver backend)"
  exec sleep infinity
fi

set -- python3 -m vllm.entrypoints.openai.api_server --model "$MODEL" --host "$HOST" --port "$PORT"
[ -n "$TOKENIZER" ] && set -- "$@" --tokenizer "$TOKENIZER"
[ -n "$TOKENIZER_MODE" ] && set -- "$@" --tokenizer-mode "$TOKENIZER_MODE"
[ -n "$MAX_MODEL_LEN" ] && set -- "$@" --max-model-len "$MAX_MODEL_LEN"
[ -n "$TENSOR_PARALLEL" ] && [ "$TENSOR_PARALLEL" -gt 0 ] && set -- "$@" --tensor-parallel-size "$TENSOR_PARALLEL"
[ -n "$GPU_MEM_UTIL" ] && set -- "$@" --gpu-memory-utilization "$GPU_MEM_UTIL"
[ -n "$DTYPE" ] && set -- "$@" --dtype "$DTYPE"
[ -n "$ENFORCE_EAGER" ] && case "$ENFORCE_EAGER" in 1 | true | yes | on) set -- "$@" --enforce-eager ;; esac
[ -n "$API_KEY" ] && set -- "$@" --api-key "$API_KEY"

echo "vllm-legacy starting: model=$MODEL host=$HOST port=$PORT tp=\${TENSOR_PARALLEL:-1} dtype=\${DTYPE:-auto} tokenizer=\${TOKENIZER:-default} tokenizer_mode=\${TOKENIZER_MODE:-auto} eager=\${ENFORCE_EAGER:-off} max_len=\${MAX_MODEL_LEN:-default}"

exec "$@"
`;
