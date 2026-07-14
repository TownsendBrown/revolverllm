import { join } from "path";
import { getRevolverRoot } from "../../electron/lib/appRoot";
import type { ServerDefinition } from "../../shared/types";
import { backendSupported, type InferenceEngine } from "../types";
import { VLLM_CAPABILITIES, VLLM_CONFIG_FIELDS } from "./capabilities";
import { buildVllmLoadEnv } from "./config";
import { ggufTokenizerRequiredMessage, resolveGgufTokenizer } from "./ggufTokenizer";
import {
  VLLM_CONTAINER_PORT,
  VLLM_ENTRYPOINT_FILE,
  VLLM_ENTRYPOINT_SCRIPT,
  vllmEnvFileName,
  vllmImage,
} from "./docker";
import { vllmMemoryEstimator } from "./memory";

export const vllmEngine: InferenceEngine = {
  id: "vllm",
  label: "vLLM",
  description: "HuggingFace safetensors/quantized models and local GGUF via vLLM OpenAI server (CUDA, multi-GPU tensor parallel)",
  capabilities: VLLM_CAPABILITIES,
  configFields: VLLM_CONFIG_FIELDS,

  validateModel(model) {
    if (!VLLM_CAPABILITIES.formats.includes(model.format)) {
      return `vLLM does not support ${model.format} models`;
    }
    if (model.format === "gguf") {
      if (model.source !== "local") {
        return "vLLM GGUF requires a local model file";
      }
      if (!model.path?.toLowerCase().endsWith(".gguf")) {
        return "vLLM GGUF requires a .gguf file path";
      }
      if (!resolveGgufTokenizer(model.path)) {
        return ggufTokenizerRequiredMessage(model.path);
      }
      return null;
    }
    if (!VLLM_CAPABILITIES.sources.includes(model.source)) {
      return `vLLM does not support ${model.source} model source`;
    }
    return null;
  },

  supportsBackend(backend) {
    return backendSupported(VLLM_CAPABILITIES, backend);
  },

  containerSpec(def: ServerDefinition) {
    const hfCache =
      process.env.REVOLVER_HF_CACHE ??
      join(getRevolverRoot(), "data", "hf-cache");
    return {
      image: vllmImage(),
      containerPort: VLLM_CONTAINER_PORT,
      entrypoint: { fileName: VLLM_ENTRYPOINT_FILE, script: VLLM_ENTRYPOINT_SCRIPT },
      env: {
        VLLM_CONFIG_DIR: "/config",
        VLLM_ENV_FILE: vllmEnvFileName(def.id),
        HF_HOME: "/root/.cache/huggingface",
        ...(process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {}),
        ...(process.env.HUGGING_FACE_HUB_TOKEN
          ? { HUGGING_FACE_HUB_TOKEN: process.env.HUGGING_FACE_HUB_TOKEN }
          : {}),
      },
      extraMounts: [{ source: hfCache, target: "/root/.cache/huggingface" }],
      envFileName: vllmEnvFileName(def.id),
      shmSize: process.env.VLLM_SHM_SIZE ?? "10g",
      ipcHost: true,
    };
  },

  buildLoadEnv: buildVllmLoadEnv,

  readiness() {
    return {
      readyMarkers: [
        "Application startup complete",
        "Starting vLLM API server",
      ],
      errorMarkers: [
        {
          match: "gpt_oss_mxfp4 is not supported",
          message:
            "gpt-oss MXFP4 requires NVIDIA compute capability 8.0+ (A100/H100). Tesla P100 (6.0) cannot run this model in vLLM — use the GGUF build with llama.cpp instead.",
        },
        {
          match: "Minimum capability:",
          message:
            "GPU compute capability too low for this vLLM model/quantization — check server logs or use llama.cpp with GGUF.",
        },
        {
          match: "ValidationError",
          message: "vLLM failed to start — see server logs for configuration/GPU errors",
        },
        {
          match: "CUDA out of memory",
          message: "CUDA OOM — reduce context length or GPU memory utilization",
        },
        {
          match: "does not exist",
          message: "Model not found — check model path or HuggingFace cache",
        },
      ],
      timeoutMs: 600_000,
      healthProbe: true,
      healthProbeIntervalMs: 10_000,
    };
  },

  idleLoadEnv() {
    return { MODEL: "" };
  },

  memory: vllmMemoryEstimator,
};
