import { join } from "path";
import { getRevolverRoot } from "../../electron/lib/appRoot";
import type { ServerDefinition } from "../../shared/types";
import { backendSupported, type InferenceEngine } from "../types";
import { LLAMACPP_CAPABILITIES, LLAMACPP_CONFIG_FIELDS } from "./capabilities";
import { buildLlamaLoadEnv } from "./config";
import {
  LLAMA_CONTAINER_PORT,
  LLAMA_ENTRYPOINT_FILE,
  LLAMA_ENTRYPOINT_SCRIPT,
  llamaEnvFileName,
  llamaImage,
} from "./docker";
import { llamaMemoryEstimator } from "./memory";

export const llamacppEngine: InferenceEngine = {
  id: "llamacpp",
  label: "llama.cpp",
  description: "GGUF models via llama-server (CPU, CUDA, ROCm, Vulkan, Metal)",
  capabilities: LLAMACPP_CAPABILITIES,
  configFields: LLAMACPP_CONFIG_FIELDS,

  validateModel(model) {
    if (model.format !== "gguf") {
      return `llama.cpp requires GGUF models (got ${model.format})`;
    }
    if (model.source !== "local") {
      return "llama.cpp requires a local model file";
    }
    return null;
  },

  supportsBackend(backend) {
    return backendSupported(LLAMACPP_CAPABILITIES, backend);
  },

  containerSpec(def: ServerDefinition) {
    // Persist the CUDA JIT (PTX→SASS) cache across container recreations.
    // Containers run with --rm, so without a host mount the driver recompiles
    // kernels on every load — a ~50s first-prefill stall on GPUs whose native
    // SASS isn't shipped in the build (e.g. Volta sm_70).
    const cudaCache =
      def.backend === "cuda"
        ? process.env.REVOLVER_CUDA_CACHE ??
          join(getRevolverRoot(), "data", "cuda-cache")
        : null;
    return {
      image: llamaImage(def.backend),
      containerPort: LLAMA_CONTAINER_PORT,
      entrypoint: { fileName: LLAMA_ENTRYPOINT_FILE, script: LLAMA_ENTRYPOINT_SCRIPT },
      env: {
        LLAMA_CONFIG_DIR: "/config",
        LLAMA_ENV_FILE: llamaEnvFileName(def.id),
        BACKEND: def.backend,
        ...(cudaCache
          ? { CUDA_CACHE_PATH: "/root/.nv/ComputeCache", CUDA_CACHE_MAXSIZE: "4294967296" }
          : {}),
      },
      extraMounts: cudaCache ? [{ source: cudaCache, target: "/root/.nv" }] : [],
      envFileName: llamaEnvFileName(def.id),
    };
  },

  buildLoadEnv: buildLlamaLoadEnv,

  readiness() {
    return {
      readyMarkers: [
        "model loaded",
        "server is listening",
        "HTTP server is listening",
        "HTTP server listening",
      ],
      errorMarkers: [
        {
          match: "model file not found",
          message: "Model file not found — check MODEL_PATH and models mount",
        },
      ],
      timeoutMs: 300_000,
    };
  },

  idleLoadEnv() {
    return { MODEL_PATH: "" };
  },

  memory: llamaMemoryEstimator,
};
