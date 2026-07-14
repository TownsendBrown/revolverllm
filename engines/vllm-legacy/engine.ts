import { join } from "path";
import { getRevolverRoot } from "../../electron/lib/appRoot";
import type { ServerDefinition } from "../../shared/types";
import { backendSupported, type InferenceEngine } from "../types";
import { vllmMemoryEstimator } from "../vllm/memory";
import { VLLM_LEGACY_CAPABILITIES, VLLM_LEGACY_CONFIG_FIELDS } from "./capabilities";
import { legacyVllmIncompatReason, legacyVllmIncompatReasonFromPath } from "./compat";
import { buildVllmLegacyLoadEnv } from "./config";
import {
  VLLM_LEGACY_CONTAINER_PORT,
  VLLM_LEGACY_ENTRYPOINT_FILE,
  VLLM_LEGACY_ENTRYPOINT_SCRIPT,
  vllmLegacyEnvFileName,
  vllmLegacyImage,
} from "./docker";

export const vllmLegacyEngine: InferenceEngine = {
  id: "vllm-legacy",
  label: "vLLM (Pascal)",
  description:
    "vLLM 0.9.x for Pascal GPUs (P100, P40) — HuggingFace safetensors only (FP16; FP32 for Gemma 2). Use llama.cpp for GGUF.",
  capabilities: VLLM_LEGACY_CAPABILITIES,
  configFields: VLLM_LEGACY_CONFIG_FIELDS,

  validateModel(model) {
    if (!VLLM_LEGACY_CAPABILITIES.formats.includes(model.format)) {
      return `vLLM Pascal supports safetensors only (not ${model.format}) — use llama.cpp for GGUF or modern vLLM for AWQ/GPTQ`;
    }
    if (!VLLM_LEGACY_CAPABILITIES.sources.includes(model.source)) {
      return `vLLM Pascal does not support ${model.source} model source`;
    }
    if (model.source === "huggingface") {
      const reason = legacyVllmIncompatReason({ modelId: model.id });
      if (reason) return reason;
    } else if (model.path) {
      const reason = legacyVllmIncompatReasonFromPath(model.path, model.id);
      if (reason) return reason;
    }
    return null;
  },

  supportsBackend(backend) {
    return backendSupported(VLLM_LEGACY_CAPABILITIES, backend);
  },

  containerSpec(def: ServerDefinition) {
    const hfCache =
      process.env.REVOLVER_HF_CACHE ??
      join(getRevolverRoot(), "data", "hf-cache");
    return {
      image: vllmLegacyImage(),
      containerPort: VLLM_LEGACY_CONTAINER_PORT,
      entrypoint: {
        fileName: VLLM_LEGACY_ENTRYPOINT_FILE,
        script: VLLM_LEGACY_ENTRYPOINT_SCRIPT,
      },
      env: {
        VLLM_CONFIG_DIR: "/config",
        VLLM_ENV_FILE: vllmLegacyEnvFileName(def.id),
        HF_HOME: "/root/.cache/huggingface",
        ...(process.env.HF_TOKEN ? { HF_TOKEN: process.env.HF_TOKEN } : {}),
        ...(process.env.HUGGING_FACE_HUB_TOKEN
          ? { HUGGING_FACE_HUB_TOKEN: process.env.HUGGING_FACE_HUB_TOKEN }
          : {}),
      },
      extraMounts: [{ source: hfCache, target: "/root/.cache/huggingface" }],
      envFileName: vllmLegacyEnvFileName(def.id),
      shmSize: process.env.VLLM_LEGACY_SHM_SIZE ?? "10g",
      ipcHost: true,
    };
  },

  buildLoadEnv: buildVllmLegacyLoadEnv,

  readiness() {
    return {
      readyMarkers: [
        "Application startup complete",
        "Starting vLLM API server",
      ],
      errorMarkers: [
        {
          match: "gpt_oss",
          message:
            "gpt-oss requires modern vLLM (compute 8.0+) — use llama.cpp GGUF on P100, not vLLM Pascal",
        },
        {
          match: "aimv2 is already used",
          message:
            "transformers version conflict — rebuild revolver/vllm-pascal:0.9.1 (see docker/vllm-pascal/Dockerfile)",
        },
        {
          match: "Transformers does not recognize this architecture",
          message:
            "Model architecture not supported by vLLM Pascal — try a different safetensors model or use llama.cpp GGUF",
        },
        {
          match: "no kernel image is available for execution on the device",
          message:
            "CUDA kernels missing for this GPU — build revolver/vllm-pascal:0.9.1 (see docker/vllm-pascal/Dockerfile)",
        },
        {
          match: "does not support float16",
          message:
            "This model rejects float16 (e.g. Gemma 2) — Revolver should auto-use float32 on Pascal; reload the model or set dtype to float",
        },
        {
          match: "BFloat16 is only supported",
          message:
            "Pascal GPUs cannot use bfloat16 — use half/float16, or float32 for Gemma 2; restart the server to pick up the latest entrypoint",
        },
        {
          match: "bfloat16 is not supported",
          message:
            "Pascal GPUs cannot use bfloat16 — use half/float16, or float32 for Gemma 2; restart the server to pick up the latest entrypoint",
        },
        {
          match: "CUDA out of memory",
          message:
            "CUDA OOM — reduce context length or GPU memory utilization (Gemma 2 on Pascal uses FP32 ≈ 2× weight VRAM)",
        },
        {
          match: "does not exist",
          message: "Model not found — check model path or HuggingFace cache",
        },
        {
          match: "Traceback (most recent call last)",
          message: "vLLM Pascal failed to start — see server logs above for details",
        },
      ],
      timeoutMs: 900_000,
      healthProbe: true,
      healthProbeIntervalMs: 10_000,
    };
  },

  idleLoadEnv() {
    return { MODEL: "" };
  },

  memory: vllmMemoryEstimator,
};
