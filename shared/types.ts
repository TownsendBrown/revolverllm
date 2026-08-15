import type {
  BenchmarkCategory,
  BenchmarkDefinition,
  BenchmarkRun,
  StartBenchmarkRequest,
} from "./benchmarks/types";

export interface ModelFile {
  path: string;
  relPath: string;
  sizeBytes: number;
  role: "entry" | "vision" | "other";
}

export interface HubModel {
  id: string;
  owner: string;
  name: string;
  displayName: string;
  hubPath: string;
  domain: string;
  architectures: string[];
  params: string;
  minMemoryBytes: number | null;
  contextLengths: number[];
  entryPoint: ModelFile | null;
  visionAdapter: ModelFile | null;
  hasWeights: boolean;
  loaded: boolean;
  revision?: number;
}

export interface CatalogModel {
  id: string;
  displayName: string;
  subtitle: string;
  path: string | null;
  sizeBytes: number | null;
  source: "hub" | "file" | "huggingface";
  /** Weight format when known (drives engine compatibility filtering). */
  format: ModelFormat | null;
  /** Engines that can run this model. */
  compatibleEngines: EngineId[];
  params: string;
  hasWeights: boolean;
  contextLengths: number[];
  minMemoryBytes: number | null;
  loaded: boolean;
}

export interface LocalGgufModel {
  id: string;
  path: string;
  relPath: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  visionPath: string | null;
  visionSizeBytes: number;
}

export interface VramEstimate {
  totalBytes: number;
  totalGb: number;
  modelVramBytes: number;
  contextVramBytes: number;
  weightsBytes: number;
  kvCacheBytes: number;
  visionAdapterBytes: number;
  overheadBytes: number;
  fitsInVram: boolean | null;
  confidence: "high" | "low";
  availableVramBytes: number | null;
  availableVramGb: number | null;
  minGpuFreeBytes: number | null;
  capacityVramBytes: number | null;
  minGpuCapacityBytes: number | null;
  gpuDeviceCount: number | null;
  peakGpuBytes: number | null;
  peakGpuGb: number | null;
  effectiveKvContext: number | null;
  slidingWindow: number | null;
  metadataSource: string | null;
  breakdown: Record<string, number>;
}

export type InferenceBackend = "cuda" | "rocm" | "vulkan" | "cpu" | "metal";
export type GpuVendor = "nvidia" | "amd" | "intel" | "apple";

export interface GpuDevice {
  index: number;
  name: string;
  vendor: GpuVendor;
  recommendedBackend: InferenceBackend;
  /** ISA / marketing arch when known (e.g. gfx1010, navi10). */
  arch?: string | null;
  /** nvidia-smi index; set for NVIDIA devices. */
  nvidiaIndex?: number | null;
  /** 0-based AMD GPU order (HIP_VISIBLE_DEVICES). */
  amdIndex?: number | null;
  /** Vulkan physical-device index (GGML_VK_VISIBLE_DEVICES). */
  vulkanIndex?: number | null;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  totalGb: number;
  freeGb: number;
  usedPercent?: number | null;
  gpuUtilPercent?: number | null;
  memUtilPercent?: number | null;
  temperatureC?: number | null;
  powerW?: number | null;
}

export interface GpuInfo {
  available: boolean;
  error?: string;
  deviceCount: number;
  totalVramBytes: number;
  totalFreeVramBytes: number;
  devices: GpuDevice[];
}

export interface SystemInfo {
  platform: string;
  hostname: string;
  cpuCount: number;
  cpuModel: string;
  cpuUsagePercent: number | null;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryFreeBytes: number;
  memoryUsedPercent: number;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskUsedPercent: number | null;
  uptimeSeconds: number;
}

export interface MonitorSnapshot {
  timestamp: string;
  system: SystemInfo;
  gpu: GpuInfo;
}

export type GpuMode = "single" | "combined";
export type ServerRuntimeMode = "docker" | "native";

/** Inference implementation (what runs the model). Orthogonal to InferenceBackend (how it executes). */
export type EngineId = "llamacpp" | "vllm" | "vllm-legacy";

export type ModelFormat = "gguf" | "safetensors" | "awq" | "gptq";
export type ModelSource = "local" | "huggingface";

export interface EngineCapabilities {
  formats: ModelFormat[];
  sources: ModelSource[];
  supportsMetal: boolean;
  supportsCUDA: boolean;
  supportsROCm: boolean;
  supportsVulkan: boolean;
  supportsCPU: boolean;
  supportsMultiGPU: boolean;
  /** Host-process llama-server (no Docker). llama.cpp only. */
  supportsNative: boolean;
  api: "openai";
}

export interface EngineConfigOption {
  value: string;
  label: string;
}

/** Declarative engine-specific setting, rendered dynamically by the UI. */
export interface EngineConfigField {
  key: string;
  label: string;
  type: "number" | "select" | "boolean" | "text";
  default: string | number | boolean;
  options?: EngineConfigOption[];
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
}

/** Serializable engine description exposed to the frontend. */
export interface EngineInfo {
  id: EngineId;
  label: string;
  description: string;
  capabilities: EngineCapabilities;
  configFields: EngineConfigField[];
}

export interface ServerDefinition {
  id: string;
  name: string;
  /** Inference implementation. Omitted in persisted defs → llamacpp. */
  engine?: EngineId;
  backend: InferenceBackend;
  /** docker (default) or native host process. Metal ignores this (always host-agent). */
  runtime?: ServerRuntimeMode;
  gpuDevices: number[];
  gpuMode: GpuMode;
  modelId: string;
  modelPath: string;
  mmprojPath: string | null;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype: string;
  /** Engine-specific settings (e.g. vLLM gpu_memory_utilization). */
  engineConfig?: Record<string, unknown>;
  hostPort: number;
  /** Optional API key required by this container's remote endpoint. null = open (default). */
  apiKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerRequest {
  name?: string;
  engine?: EngineId;
  backend: InferenceBackend;
  runtime?: ServerRuntimeMode;
  gpuDevices: number[];
  gpuMode?: GpuMode;
  modelId: string;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype?: string;
  engineConfig?: Record<string, unknown>;
  apiKey?: string | null;
  force?: boolean;
}

export interface LoadedModelState {
  modelId: string;
  modelPath: string;
  backendId: string;
  contextLength: number;
  nGpuLayers: number;
  port: number;
  host: string;
  pid: number | null;
  startedAt: string | null;
  mmprojPath: string | null;
  running: boolean;
  jitLoaded: boolean;
  ttlSeconds: number | null;
  ttlExpiresAt: string | null;
  serverId?: string;
  serverName?: string;
  gpuDevices?: number[];
  gpuMode?: GpuMode;
}

export interface ServerInstanceStatus {
  definition: ServerDefinition;
  loaded: LoadedModelState | null;
  running: boolean;
  loadPhase: ServerLoadPhase;
  loadError?: string | null;
  loadProgress: LoadProgress | null;
  lastSpeedTps: number | null;
  port: number;
  host: string;
  baseUrl: string;
  /** Unified OpenAI gateway URL (fixed port, routes by model). */
  gatewayUrl: string;
  endpoints: string[];
  logs: string[];
  logsFiltered: string[];
  /** Revolver orchestration lines (`[revolver] …`) shown in Container logs. */
  containerLogs: string[];
  /** Raw llama-server output from `docker logs` (timing, slots, inference). */
  serverLogs: string[];
  generation: GenerationState | null;
  /**
   * Whether the loaded chat template supports thinking / reasoning.
   * Detected from `GET /props` when available; null = unknown (UI may fall back).
   */
  supportsReasoning: boolean | null;
  /** Context window from /props `n_ctx` when known; else null (use definition.contextLength). */
  nCtx: number | null;
}

export interface ServersOverview extends ServerStatus {
  servers: ServerInstanceStatus[];
  activeCount: number;
  primaryServerId: string | null;
}

export interface ServerStatus {
  loaded: LoadedModelState | null;
  running: boolean;
  loadPhase: ServerLoadPhase;
  /** Set when the most recent load attempt failed (Docker async load). */
  loadError?: string | null;
  loadProgress: LoadProgress | null;
  lastSpeedTps: number | null;
  port: number;
  host: string;
  baseUrl: string;
  gatewayUrl: string;
  endpoints: string[];
  logs: string[];
  logsFiltered: string[];
  containerLogs: string[];
  serverLogs: string[];
  jit: { enabled: boolean; autoEvict: boolean; ttlSeconds: number };
  ttlExpiresAt: string | null;
  generation: GenerationState | null;
  /** Present when multi-server mode is active. */
  servers?: ServerInstanceStatus[];
  activeCount?: number;
  primaryServerId?: string | null;
}

export type GenerationStage = "queued" | "generating" | "done" | "error";

export interface GenerationState {
  prompt: string;
  stage: GenerationStage;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  ttftMs: number | null;
  error: string | null;
}

export type ServerLoadPhase = "idle" | "loading" | "ready" | "inferring";

export interface LoadProgressStep {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
}

export interface LoadProgress {
  percent: number;
  stage: string;
  steps: LoadProgressStep[];
  elapsedMs?: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  cors: boolean;
  gatewayEnabled: boolean;
  gatewayApiKey: string | null;
  verbose: boolean;
  logLinesLimit: number;
  autoStartOnLaunch: boolean;
  justInTimeModelLoading: boolean;
  autoEvict: boolean;
  jitModelTTL: { enabled: boolean; ttlSeconds: number };
}

export type GuardrailMode = "off" | "low" | "medium" | "high" | "custom";

export interface GuardrailResult {
  passes: boolean;
  mode: GuardrailMode;
  reason: string;
  requiredFreeBytes: number | null;
  availableBytes: number | null;
}

export interface RuntimeConfig {
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype: string;
  backendId: string | null;
  lastModelId: string | null;
}

/** Host paths visible to the OS file manager (Docker maps container paths to these). */
export interface PlatformHostPaths {
  modelsDir: string;
  hubModelsDir: string;
  localRoot: string;
  repoRoot: string;
}

/** Runtime platform flags (not persisted). */
export interface PlatformCapabilities {
  /** True when Revolver runs with macOS Metal host-agent (docker:up:mac). */
  macMetal: boolean;
  /** True when the backend container was started with GPU support (LLAMA_GPU=1). */
  dockerGpu: boolean;
  /** True when the Docker daemon is reachable. */
  docker: boolean;
  /** Last Docker probe error when `docker` is false. */
  dockerError?: string;
  /** True when a host llama-server binary is available and Compose is not pinning Docker. */
  native: boolean;
  nativeError?: string;
  llamaServerBin?: string | null;
  /** Installed CUDA pack id (e.g. linux-cuda-sm70). macOS Metal is not a pack. */
  nativeBackendPack?: string | null;
  /** Default for new servers (REVOLVER_RUNTIME or pack:native extraMetadata). */
  defaultRuntime: ServerRuntimeMode;
  os: "darwin" | "linux" | "win32" | "other";
  /** True when openPath can reach the host file manager. */
  canOpenPath: boolean;
  /** Host-side paths when running in Docker (for display / open folder). */
  hostPaths?: PlatformHostPaths;
}

export interface LocalPaths {
  root: string;
  hubModels: string;
  downloads: string;
  internal: string;
  settings: string;
  configPath: string;
  dataDir: string;
  /** Revolver repo root on the host (codebase). */
  repoRoot: string;
}

export interface RevolverConfig {
  modelsDir: string;
  hubModelsDir: string;
  localRoot: string;
}

export interface LocalSettings {
  downloadsFolder: string;
  defaultContextLength: { type: string; value: number };
  enableLocalService: boolean;
  modelLoadingGuardrails: {
    mode: string;
    customThresholdBytes: number;
    alwaysAllowLoadAnyway?: boolean;
  };
}

export interface ChatConversation {
  id: string;
  title: string;
  modelId: string | null;
  modelPath: string | null;
  modelDisplayName: string | null;
  backendId: string | null;
  serverId: string | null;
  contextLength: number | null;
  nGpuLayers: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Model reasoning / chain-of-thought when emitted separately from the reply. */
  reasoning: string | null;
  createdAt: string;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  ttftMs: number | null;
}

/** Incremental stream chunk from chat completions (content and/or reasoning). */
export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

export interface ConversationMeta {
  title?: string;
  modelId?: string | null;
  modelPath?: string | null;
  modelDisplayName?: string | null;
  backendId?: string | null;
  serverId?: string | null;
  contextLength?: number | null;
  nGpuLayers?: number | null;
}

export interface ConversationDetail {
  conversation: ChatConversation;
  messages: ChatMessage[];
}

export interface SendMessageOptions {
  serverId?: string | null;
  /** When set, request enables/disables model thinking for this turn. */
  enableThinking?: boolean;
  onDelta?: (delta: StreamDelta) => void;
  signal?: AbortSignal;
}

export interface SendMessageResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export type {
  BenchmarkCategory,
  BenchmarkCheckResult,
  BenchmarkDefinition,
  BenchmarkDefinitionVersion,
  BenchmarkRun,
  BenchmarkRunConfig,
  BenchmarkRunStatus,
  BenchmarkTestResult,
  StartBenchmarkRequest,
} from "./benchmarks/types";

export interface RevolverApi {
  getPaths(): Promise<LocalPaths & { settings: LocalSettings; config: RevolverConfig }>;
  getConfig(): Promise<RevolverConfig>;
  setConfig(patch: Partial<RevolverConfig>): Promise<RevolverConfig>;
  getGpu(): Promise<GpuInfo>;
  getPlatform(): Promise<PlatformCapabilities>;
  getMonitor(): Promise<MonitorSnapshot>;
  getModels(): Promise<{
    models: CatalogModel[];
    paths: { hub: string; downloads: string; root: string };
  }>;
  getEngines(): Promise<EngineInfo[]>;
  estimateVram(opts: {
    modelId?: string;
    modelPath?: string;
    engine?: EngineId;
    contextLength: number;
    nGpuLayers: number;
    kvCacheDtype?: string;
    gpuDeviceCount?: number;
    gpuDevices?: number[];
    backend?: string | null;
    engineConfig?: Record<string, unknown>;
  }): Promise<{
    estimate: VramEstimate;
    contextLength: number;
    modelMaxContext: number | null;
    passesGuardrails: boolean;
    guardrail: GuardrailResult;
  }>;
  loadModel(opts: {
    modelId: string;
    contextLength: number;
    nGpuLayers: number;
    force?: boolean;
  }): Promise<LoadedModelState | ServerStatus>;
  loadModelFromPath(opts: {
    path: string;
    contextLength: number;
    nGpuLayers: number;
    force?: boolean;
  }): Promise<LoadedModelState | ServerStatus>;
  pickModelFile(): Promise<string | null>;
  unloadModel(): Promise<void>;
  listServers(): Promise<ServerInstanceStatus[]>;
  getServerStatus(serverId?: string): Promise<ServerStatus>;
  createServer(opts: CreateServerRequest): Promise<ServerInstanceStatus>;
  startServer(serverId: string, force?: boolean): Promise<ServerInstanceStatus>;
  stopServer(serverId: string): Promise<void>;
  deleteServer(serverId: string): Promise<void>;
  clearServerLogs(serverId?: string): Promise<void>;
  getServerConfig(): Promise<ServerConfig>;
  setServerConfig(patch: Partial<ServerConfig>): Promise<ServerConfig>;
  getRuntimeConfig(): Promise<RuntimeConfig>;
  setRuntimeConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig>;
  chat(messages: Array<{ role: string; content: string }>, serverId?: string): Promise<unknown>;
  listConversations(): Promise<ChatConversation[]>;
  createConversation(meta?: ConversationMeta): Promise<ChatConversation>;
  getConversation(id: string): Promise<ConversationDetail>;
  renameConversation(id: string, title: string): Promise<ChatConversation>;
  updateConversationMeta(conversationId: string, meta: ConversationMeta): Promise<ChatConversation>;
  deleteConversation(id: string): Promise<void>;
  sendMessage(
    conversationId: string,
    content: string,
    opts?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  openPath(path: string): Promise<string>;
  /** Electron: restore OS/webContents focus so chat inputs accept clicks after dialogs. */
  focusWindow(): Promise<void>;
  listBenchmarkDefinitions(): Promise<BenchmarkDefinition[]>;
  listBenchmarkRuns(): Promise<BenchmarkRun[]>;
  getBenchmarkRun(id: string): Promise<BenchmarkRun>;
  startBenchmarkRun(req: StartBenchmarkRequest): Promise<BenchmarkRun>;
  cancelBenchmarkRun(id: string): Promise<BenchmarkRun | null>;
  deleteBenchmarkRun(id: string): Promise<void>;
  setBenchmarkHumanScore(
    runId: string,
    testId: BenchmarkCategory,
    humanScore: number,
    humanMaxScore?: number,
    humanNotes?: string,
  ): Promise<BenchmarkRun>;
  readBenchmarkArtifact(runId: string, testId: string, filename: string): Promise<string>;
}

declare global {
  interface Window {
    revolver?: RevolverApi;
  }
}
