import { readHfConfig } from "../../electron/lib/hfModels";
import { normalizeModelPath } from "../../electron/lib/modelPaths";

/** Model types / architectures vLLM Pascal (sasha0552 v0.9.x) cannot load. */
const BLOCKED_MODEL_TYPES = new Set(["gpt_oss"]);

const BLOCKED_ARCH_PATTERNS = [/gpt_oss/i, /gptoss/i, /mxfp4/i];

const BLOCKED_ID_PATTERNS = [/gpt-oss/i, /gpt_oss/i];

export interface LegacyModelMeta {
  modelType?: string;
  architectures?: string[];
  modelId?: string;
}

export function legacyVllmIncompatReason(meta: LegacyModelMeta): string | null {
  const modelType = meta.modelType?.toLowerCase();
  if (modelType && BLOCKED_MODEL_TYPES.has(modelType)) {
    return (
      "gpt-oss requires modern vLLM (compute 8.0+ / A100+) — vLLM Pascal cannot load this architecture; use llama.cpp with GGUF instead"
    );
  }

  for (const arch of meta.architectures ?? []) {
    if (BLOCKED_ARCH_PATTERNS.some((pat) => pat.test(arch))) {
      return `vLLM Pascal does not support ${arch} — use llama.cpp GGUF on Pascal or modern vLLM on newer GPUs`;
    }
  }

  const id = meta.modelId ?? "";
  if (BLOCKED_ID_PATTERNS.some((pat) => pat.test(id))) {
    return `vLLM Pascal does not support ${id} — use llama.cpp GGUF on Pascal GPUs`;
  }

  return null;
}

export function legacyVllmIncompatReasonFromPath(modelPath: string, modelId?: string): string | null {
  const byId = legacyVllmIncompatReason({ modelId: modelId ?? modelPath });
  if (byId) return byId;

  const path = normalizeModelPath(modelPath);
  const config = readHfConfig(path);
  if (!config) return null;

  const architectures = Array.isArray(config.architectures)
    ? (config.architectures as string[])
    : config.model_type
      ? [String(config.model_type)]
      : [];

  return legacyVllmIncompatReason({
    modelType: config.model_type != null ? String(config.model_type) : undefined,
    architectures,
    modelId,
  });
}
