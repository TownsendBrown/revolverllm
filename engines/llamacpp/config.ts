import { LOAD_DEFAULTS } from "../../electron/lib/localMeta";
import { normalizeModelPath, toContainerModelPath } from "../../electron/lib/modelPaths";
import { effectiveGpuLayers } from "../../electron/lib/vram";
import type { ServerDefinition } from "../../shared/types";
import type { LoadEnvPlan } from "../types";
import { LLAMA_CONTAINER_PORT } from "./docker";

/**
 * `--gpus device=<host indices>` isolates the requested GPUs, but the runtime
 * renumbers them inside the container starting at 0. So *_VISIBLE_DEVICES inside
 * the container must reference relative indices (0..n-1), NOT the host indices.
 */
function relativeVisibleDevices(def: ServerDefinition): string {
  return def.gpuDevices.map((_, i) => i).join(",");
}

/** Env-file contents the llama entrypoint (container or Metal host agent) sources on restart. */
export function buildLlamaLoadEnv(def: ServerDefinition): LoadEnvPlan {
  const modelPath = normalizeModelPath(def.modelPath);
  const gpuLayers = effectiveGpuLayers(def.backend, def.nGpuLayers);
  const mapPath = (p: string) =>
    def.backend === "metal" ? p : toContainerModelPath(p);

  // KV cache quantization (anything other than f16) requires Flash Attention,
  // otherwise llama.cpp dequantizes every step and runs slower. Force `-fa on`
  // when quantizing; leave it on `auto` (llama.cpp default) for plain f16.
  const kvDtype = (def.kvCacheDtype || "f16").toLowerCase();
  const quantKv = kvDtype !== "f16";

  return {
    env: {
      MODEL_PATH: mapPath(modelPath),
      CTX_SIZE: def.contextLength,
      N_GPU_LAYERS: gpuLayers,
      LLAMA_HOST: "0.0.0.0",
      LLAMA_PORT: LLAMA_CONTAINER_PORT,
      BACKEND: def.backend,
      MMPROJ_PATH: def.mmprojPath
        ? mapPath(normalizeModelPath(def.mmprojPath))
        : undefined,
      FLASH_ATTN: quantKv ? "on" : "auto",
      CACHE_TYPE_K: quantKv ? kvDtype : undefined,
      CACHE_TYPE_V: quantKv ? kvDtype : undefined,
      // llama-server defaults (n_parallel=4, kv_unified=true, thinking=0).
      N_PARALLEL: LOAD_DEFAULTS.maxParallelPredictions,
      KV_UNIFIED: LOAD_DEFAULTS.useUnifiedKvCache ? "1" : undefined,
      // Allow per-request enable_thinking; default off so chat stays snappy.
      REASONING: "auto",
      // Prefer separate reasoning_content field when the template emits thoughts.
      REASONING_FORMAT: "deepseek",
      // Container-relative indices: `--gpus device=` already isolates the host
      // GPUs and renumbers them from 0, so host indices would point at nothing.
      CUDA_VISIBLE_DEVICES: def.gpuDevices.length ? relativeVisibleDevices(def) : undefined,
    },
    logLines: [
      `[revolver] model=${modelPath} ctx=${def.contextLength} gpu_layers=${gpuLayers}`,
    ],
  };
}
