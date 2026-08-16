import type { EngineInfo } from "../shared/types";
import {
  DEFAULT_ENGINE,
  enginesForFormat,
  enginesForModel,
  getEngine,
  listEngines,
  registerEngine,
} from "./registry";

export {
  DEFAULT_ENGINE,
  enginesForFormat,
  enginesForModel,
  getEngine,
  listEngines,
  registerEngine,
};
export type {
  InferenceEngine,
  ModelRef,
  EngineContainerSpec,
  LoadEnvPlan,
  ReadinessSpec,
  MemoryEstimator,
  MemoryEstimateRequest,
  MemoryEstimateResult,
} from "./types";

export function engineInfos(): EngineInfo[] {
  return listEngines()
    .filter((e) => e.id !== "mlx" || process.platform === "darwin")
    .map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      capabilities: e.capabilities,
      configFields: e.configFields,
    }));
}
