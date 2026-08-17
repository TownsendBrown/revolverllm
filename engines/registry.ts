import type { EngineId, ModelFormat } from "../shared/types";
import { llamacppEngine } from "./llamacpp/engine";
import { mlxEngine } from "./mlx/engine";
import { legacyVllmIncompatReason } from "./vllm-legacy/compat";
import { vllmLegacyEngine } from "./vllm-legacy/engine";
import { vllmEngine } from "./vllm/engine";
import type { InferenceEngine } from "./types";

const registry = new Map<EngineId, InferenceEngine>([
  [llamacppEngine.id, llamacppEngine],
  [vllmEngine.id, vllmEngine],
  [vllmLegacyEngine.id, vllmLegacyEngine],
  [mlxEngine.id, mlxEngine],
]);

/**
 * macOS ships without Docker, so only the natively spawnable engines
 * (llama.cpp, MLX) are usable there — vLLM images would never start.
 * MLX in turn only exists on macOS.
 */
export function engineAllowedOnThisHost(engine: InferenceEngine): boolean {
  if (process.platform === "darwin") return engine.capabilities.supportsNative;
  return engine.id !== "mlx";
}

export const DEFAULT_ENGINE: EngineId = "llamacpp";

export function registerEngine(engine: InferenceEngine): void {
  registry.set(engine.id, engine);
}

/** Engines that can run the given model format (drives UI compatibility filtering). */
export function enginesForFormat(format: ModelFormat): EngineId[] {
  return [...registry.values()]
    .filter((e) => e.capabilities.formats.includes(format))
    .filter(engineAllowedOnThisHost)
    .map((e) => e.id);
}

/** Format + architecture aware engine list (excludes vLLM Pascal for unsupported HF models). */
export function enginesForModel(opts: {
  format: ModelFormat;
  modelId?: string;
  modelType?: string;
  architectures?: string[];
}): EngineId[] {
  const engines = enginesForFormat(opts.format);
  if (!engines.includes("vllm-legacy")) return engines;
  const blocked = legacyVllmIncompatReason({
    modelId: opts.modelId,
    modelType: opts.modelType,
    architectures: opts.architectures,
  });
  if (blocked) return engines.filter((e) => e !== "vllm-legacy");
  return engines;
}

export function listEngines(): InferenceEngine[] {
  return [...registry.values()];
}

export function getEngine(id?: EngineId | string | null): InferenceEngine {
  const engine = registry.get((id ?? DEFAULT_ENGINE) as EngineId);
  if (!engine) throw new Error(`Unknown inference engine: ${id}`);
  return engine;
}
