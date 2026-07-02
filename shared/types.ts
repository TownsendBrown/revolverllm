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
  source: "hub" | "file";
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

export interface GpuInfo {
  available: boolean;
  error?: string;
  deviceCount: number;
  totalVramBytes: number;
  totalFreeVramBytes: number;
  devices: Array<{
    index: number;
    name: string;
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
  }>;
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

export type InferenceBackend = "cuda" | "rocm" | "vulkan" | "cpu" | "metal";
export type GpuMode = "single" | "combined";

export interface ServerDefinition {
  id: string;
  name: string;
  backend: InferenceBackend;
  gpuDevices: number[];
  gpuMode: GpuMode;
  modelId: string;
  modelPath: string;
  mmprojPath: string | null;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype: string;
  hostPort: number;
  /** Optional API key required by this container's remote endpoint. null = open (default). */
  apiKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerRequest {
  name?: string;
  backend: InferenceBackend;
  gpuDevices: number[];
  gpuMode?: GpuMode;
  modelId: string;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype?: string;
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
  endpoints: string[];
  logs: string[];
  logsFiltered: string[];
  /** Revolver orchestration lines (`[revolver] …`) shown in Container logs. */
  containerLogs: string[];
  /** Raw llama-server output from `docker logs` (timing, slots, inference). */
  serverLogs: string[];
  generation: GenerationState | null;
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
  createdAt: string;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  ttftMs: number | null;
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
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface SendMessageResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

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
  estimateVram(opts: {
    modelId?: string;
    modelPath?: string;
    contextLength: number;
    nGpuLayers: number;
    kvCacheDtype?: string;
    gpuDeviceCount?: number;
    gpuDevices?: number[];
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
}

declare global {
  interface Window {
    revolver: RevolverApi;
  }
}
