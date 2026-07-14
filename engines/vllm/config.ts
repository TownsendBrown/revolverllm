import { normalizeModelPath, toContainerModelPath } from "../../electron/lib/modelPaths";
import type { ServerDefinition } from "../../shared/types";
import type { LoadEnvPlan } from "../types";
import { resolveGgufTokenizer, resolveVllmTokenizerMode } from "./ggufTokenizer";
import { VLLM_CONTAINER_PORT } from "./docker";

function relativeVisibleDevices(def: ServerDefinition): string {
  return def.gpuDevices.map((_, i) => i).join(",");
}

function tensorParallelSize(def: ServerDefinition): number {
  if (def.gpuMode === "single" && def.gpuDevices.length > 1) return 1;
  return Math.max(1, def.gpuDevices.length || 1);
}

function vllmQuantization(def: ServerDefinition): string | undefined {
  const fmt = String(def.engineConfig?.modelFormat ?? "").toLowerCase();
  if (fmt === "awq") return "awq";
  if (fmt === "gptq") return "gptq";
  if (fmt === "gguf") return "gguf";
  return undefined;
}

function vllmDtype(def: ServerDefinition): string | undefined {
  const fmt = String(def.engineConfig?.modelFormat ?? "").toLowerCase();
  if (fmt === "gguf") return undefined;
  const dtype = String(def.engineConfig?.dtype ?? "auto");
  return dtype !== "auto" ? dtype : undefined;
}

function vllmModelArg(def: ServerDefinition): string {
  const source = String(def.engineConfig?.modelSource ?? "local");
  if (source === "huggingface") return def.modelId;
  return toContainerModelPath(normalizeModelPath(def.modelPath));
}

/** Env-file contents the vLLM entrypoint sources on restart. */
export function buildVllmLoadEnv(def: ServerDefinition): LoadEnvPlan {
  const tp = tensorParallelSize(def);
  const cfg = def.engineConfig ?? {};
  const gpuMem = Number(cfg.gpu_memory_utilization ?? 0.9);
  const dtype = vllmDtype(def);
  const enforceEager = cfg.enforce_eager === true ? "1" : undefined;
  const quant = vllmQuantization(def);
  const fmt = String(def.engineConfig?.modelFormat ?? "").toLowerCase();
  const tokenizer =
    fmt === "gguf" && def.modelPath ? resolveGgufTokenizer(def.modelPath) : undefined;
  const tokenizerMode = resolveVllmTokenizerMode(def.modelPath ?? def.modelId, {
    tokenizer,
    modelId: def.modelId,
  });

  return {
    env: {
      MODEL: vllmModelArg(def),
      TOKENIZER: tokenizer,
      TOKENIZER_MODE: tokenizerMode,
      VLLM_HOST: "0.0.0.0",
      VLLM_PORT: VLLM_CONTAINER_PORT,
      MAX_MODEL_LEN: def.contextLength,
      TENSOR_PARALLEL_SIZE: tp,
      GPU_MEMORY_UTILIZATION: gpuMem,
      DTYPE: dtype,
      QUANTIZATION: quant,
      ENFORCE_EAGER: enforceEager,
      CUDA_VISIBLE_DEVICES: def.gpuDevices.length ? relativeVisibleDevices(def) : undefined,
    },
    logLines: [
      `[revolver] model=${def.modelId} ctx=${def.contextLength} tensor_parallel=${tp}`,
    ],
  };
}
