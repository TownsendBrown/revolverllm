import type {
  EngineCapabilities,
  EngineConfigField,
  EngineId,
  InferenceBackend,
  ModelFormat,
  ModelSource,
  ServerDefinition,
  VramEstimate,
} from "../shared/types";

/** A resolved model reference, format- and source-aware. */
export interface ModelRef {
  id: string;
  format: ModelFormat;
  source: ModelSource;
  /** Filesystem path for local models; repo id for huggingface models. */
  path: string;
}

export interface ContainerMount {
  /** Host path or named volume. */
  source: string;
  target: string;
  readOnly?: boolean;
}

/**
 * Everything the container layer needs to create a per-server container.
 * containerUtils applies this spec; it contains no engine-specific logic itself.
 */
export interface EngineContainerSpec {
  image: string;
  /** Port the inference server listens on inside the container. */
  containerPort: number;
  /** Entrypoint script written into the shared config volume. */
  entrypoint: { fileName: string; script: string };
  /** Static container environment (config dir, env-file name, caches, …). */
  env: Record<string, string>;
  /** Engine-specific mounts beyond the standard models mount (e.g. HF cache). */
  extraMounts: ContainerMount[];
  /** Per-server env file the entrypoint sources on (re)start. */
  envFileName: string;
  /** Docker --shm-size (vLLM needs generous shared memory for KV cache). */
  shmSize?: string;
  /** Docker --ipc host (recommended for vLLM tensor parallel). */
  ipcHost?: boolean;
}

/** Env-file contents written before a (re)start, plus orchestration log lines. */
export interface LoadEnvPlan {
  env: Record<string, string | number | null | undefined>;
  logLines: string[];
}

export interface ReadinessSpec {
  /** Log lines that indicate the server may be ready (triggers a health probe). */
  readyMarkers: string[];
  /** Log lines that indicate a fatal load error. */
  errorMarkers: Array<{ match: string; message: string }>;
  /** Max time to wait for a load before failing. */
  timeoutMs: number;
  /** Poll /health (and /v1/models) directly — Desktop VLLM style. */
  healthProbe?: boolean;
  /** Ms between health polls when healthProbe is set (default 10s). */
  healthProbeIntervalMs?: number;
}

export interface MemoryEstimateRequest {
  model: ModelRef;
  /** Original catalog/model id (for hub metadata lookups). */
  modelId?: string;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype?: string;
  backend?: string | null;
  gpuDevices: Array<{ index: number; freeBytes: number; totalBytes: number }>;
  gpuDeviceCount: number | null;
  engineConfig?: Record<string, unknown>;
}

export interface MemoryEstimateResult {
  estimate: VramEstimate;
  contextLength: number;
  modelMaxContext: number | null;
}

export interface MemoryEstimator {
  estimate(req: MemoryEstimateRequest): Promise<MemoryEstimateResult>;
}

/**
 * An inference implementation (llama.cpp, vLLM, …). Engines translate a
 * ServerDefinition into container/runtime configuration; they never touch
 * the Docker lifecycle or GPU device assignment directly.
 */
export interface InferenceEngine {
  readonly id: EngineId;
  readonly label: string;
  readonly description: string;
  readonly capabilities: EngineCapabilities;
  readonly configFields: EngineConfigField[];

  /** Returns an error message when the model is incompatible, else null. */
  validateModel(model: Pick<ModelRef, "format" | "source" | "path" | "id">): string | null;

  supportsBackend(backend: InferenceBackend): boolean;

  /** Container image/entrypoint/env/mounts for this server definition. */
  containerSpec(def: ServerDefinition): EngineContainerSpec;

  /** Env-file contents consumed by the engine entrypoint on restart. */
  buildLoadEnv(def: ServerDefinition): LoadEnvPlan;

  readiness(def: ServerDefinition): ReadinessSpec;

  /** Env values that put the server in idle/unloaded state. */
  idleLoadEnv(): Record<string, string | number | null | undefined>;

  readonly memory: MemoryEstimator;
}

/** Shared backend→capability check so engines stay consistent. */
export function backendSupported(caps: EngineCapabilities, backend: InferenceBackend): boolean {
  switch (backend) {
    case "cuda":
      return caps.supportsCUDA;
    case "rocm":
      return caps.supportsROCm;
    case "vulkan":
      return caps.supportsVulkan;
    case "metal":
      return caps.supportsMetal;
    case "cpu":
      return caps.supportsCPU;
  }
}
