import { LOAD_DEFAULTS } from "../../electron/lib/localMeta";
import { normalizeModelPath, toContainerModelPath } from "../../electron/lib/modelPaths";
import { getGpuInfo } from "../../electron/lib/gpu";
import { effectiveGpuLayers } from "../../electron/lib/vram";
import { vulkanDriverEnv } from "../../shared/gpuDevices";
import { usesHostModelPaths, visibleDeviceEnv } from "../../shared/runtimeMode";
import type { ServerDefinition } from "../../shared/types";
import type { LoadEnvPlan } from "../types";
import { LLAMA_CONTAINER_PORT } from "./docker";

/** Env-file contents the llama entrypoint (container or native host process) sources on restart. */
export function buildLlamaLoadEnv(def: ServerDefinition): LoadEnvPlan {
  const modelPath = normalizeModelPath(def.modelPath);
  const gpuLayers = effectiveGpuLayers(def.backend, def.nGpuLayers);
  const hostPaths = usesHostModelPaths(def);
  const mapPath = (p: string) => (hostPaths ? p : toContainerModelPath(p));

  // KV cache quantization (anything other than f16) requires Flash Attention,
  // otherwise llama.cpp dequantizes every step and runs slower. Force `-fa on`
  // when quantizing; leave it on `auto` (llama.cpp default) for plain f16.
  const kvDtype = (def.kvCacheDtype || "f16").toLowerCase();
  const quantKv = kvDtype !== "f16";
  const vkEnv =
    def.backend === "vulkan"
      ? hostPaths
        ? {
            VK_LOADER_DRIVERS_DISABLE: "lvp",
            ...(def.gpuDevices.length
              ? { GGML_VK_VISIBLE_DEVICES: def.gpuDevices.join(",") }
              : {}),
          }
        : vulkanDriverEnv(
            (() => {
              try {
                return getGpuInfo().devices;
              } catch {
                return [];
              }
            })(),
            def.gpuDevices,
          )
      : {};

  return {
    env: {
      MODEL_PATH: mapPath(modelPath),
      CTX_SIZE: def.contextLength,
      N_GPU_LAYERS: gpuLayers,
      LLAMA_HOST: "0.0.0.0",
      LLAMA_PORT: hostPaths ? def.hostPort : LLAMA_CONTAINER_PORT,
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
      // auto picks the right API schema per template (required for gpt-oss Harmony channels).
      REASONING_FORMAT: "auto",
      API_KEY: def.apiKey ?? undefined,
      ...visibleDeviceEnv(def),
      ...vkEnv,
    },
    logLines: [
      `[revolver] model=${modelPath} ctx=${def.contextLength} gpu_layers=${gpuLayers}`,
    ],
  };
}
