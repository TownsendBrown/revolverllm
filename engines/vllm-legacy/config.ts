import { readHfConfig } from "../../electron/lib/hfModels";
import { normalizeModelPath, toContainerModelPath } from "../../electron/lib/modelPaths";
import type { ServerDefinition } from "../../shared/types";
import type { LoadEnvPlan } from "../types";
import { resolveVllmTokenizerMode } from "../vllm/ggufTokenizer";
import { VLLM_LEGACY_CONTAINER_PORT } from "./docker";

function relativeVisibleDevices(def: ServerDefinition): string {
  return def.gpuDevices.map((_, i) => i).join(",");
}

function tensorParallelSize(def: ServerDefinition): number {
  if (def.gpuMode === "single" && def.gpuDevices.length > 1) return 1;
  return Math.max(1, def.gpuDevices.length || 1);
}

function modelFormat(def: ServerDefinition): string {
  return String(def.engineConfig?.modelFormat ?? "").toLowerCase();
}

function vllmLegacyModelArg(def: ServerDefinition): string {
  const source = String(def.engineConfig?.modelSource ?? "local");
  if (source === "huggingface") return def.modelId;
  return toContainerModelPath(normalizeModelPath(def.modelPath));
}

/**
 * Gemma 2 rejects float16 (numerical instability) and prefers bfloat16.
 * Pascal has no BF16, so vLLM must run these in float32.
 */
export function modelRequiresFloat32OnPascal(def: Pick<ServerDefinition, "modelId" | "modelPath">): boolean {
  const hay = [def.modelId, def.modelPath].filter(Boolean).join(" ").toLowerCase();
  if (/gemma-?2\b/.test(hay) || /gemma2/.test(hay)) return true;

  const path = def.modelPath ? normalizeModelPath(def.modelPath) : "";
  if (!path) return false;

  const config = readHfConfig(path);
  if (!config) return false;
  if (String(config.model_type ?? "").toLowerCase() === "gemma2") return true;
  const arches = config.architectures;
  return Array.isArray(arches) && arches.some((a) => /gemma2/i.test(String(a)));
}

function vllmLegacyDtype(def: ServerDefinition): string {
  return normalizeLegacyDtype(def.engineConfig?.dtype, {
    forceFloat32: modelRequiresFloat32OnPascal(def),
  });
}

/** Map legacy/auto/bf16 dtype values for Pascal (vLLM 0.9: "float" = FP32). */
export function normalizeLegacyDtype(
  raw: unknown,
  opts?: { forceFloat32?: boolean },
): string {
  const dtype = String(raw ?? (opts?.forceFloat32 ? "float" : "half")).toLowerCase();
  if (dtype === "float32" || dtype === "fp32") return "float";
  if (dtype === "fp16") return "float16";

  if (opts?.forceFloat32) {
    // Gemma 2 rejects FP16; Pascal has no BF16 → float32.
    if (
      dtype === "half" ||
      dtype === "float16" ||
      dtype === "auto" ||
      dtype === "bfloat16" ||
      dtype === "bf16"
    ) {
      return "float";
    }
    return dtype === "float" ? "float" : dtype;
  }

  // Default Pascal path: treat auto/bf16 as FP16. Explicit float stays FP32.
  if (dtype === "auto" || dtype === "bfloat16" || dtype === "bf16") {
    return "half";
  }
  return dtype;
}

/** Env-file contents the legacy vLLM entrypoint sources on restart. */
export function buildVllmLegacyLoadEnv(def: ServerDefinition): LoadEnvPlan {
  const tp = tensorParallelSize(def);
  const cfg = def.engineConfig ?? {};
  const fmt = modelFormat(def);
  const gpuMem = Number(cfg.gpu_memory_utilization ?? 0.9);
  const dtype = vllmLegacyDtype(def);
  const enforceEager = cfg.enforce_eager === false ? undefined : "1";
  const tokenizerMode = resolveVllmTokenizerMode(def.modelPath ?? def.modelId, {
    modelId: def.modelId,
  });

  return {
    env: {
      MODEL: vllmLegacyModelArg(def),
      TOKENIZER_MODE: tokenizerMode,
      VLLM_HOST: "0.0.0.0",
      VLLM_PORT: VLLM_LEGACY_CONTAINER_PORT,
      MAX_MODEL_LEN: def.contextLength,
      TENSOR_PARALLEL_SIZE: tp,
      GPU_MEMORY_UTILIZATION: gpuMem,
      DTYPE: dtype,
      ENFORCE_EAGER: enforceEager,
      CUDA_VISIBLE_DEVICES: def.gpuDevices.length ? relativeVisibleDevices(def) : undefined,
    },
    logLines: [
      `[revolver] engine=vllm-legacy model=${def.modelId} format=${fmt || "safetensors"} ctx=${def.contextLength} tensor_parallel=${tp} dtype=${dtype} tokenizer_mode=${tokenizerMode ?? "auto"} enforce_eager=${enforceEager ?? "off"}`,
    ],
  };
}
