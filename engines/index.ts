import type { EngineInfo } from "../shared/types";
import {
  DEFAULT_ENGINE,
  engineAllowedOnThisHost,
  enginesForFormat,
  enginesForModel,
  getEngine,
  listEngines,
  registerEngine,
} from "./registry";

export {
  DEFAULT_ENGINE,
  engineAllowedOnThisHost,
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
    .filter(engineAllowedOnThisHost)
    .map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      capabilities: e.capabilities,
      configFields: e.configFields,
    }));
}
