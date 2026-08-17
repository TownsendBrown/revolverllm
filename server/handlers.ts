import { clampContextLength } from "../electron/lib/contextLength";
import { getGpuInfoAsync, getMonitorSnapshotAsync } from "./platformGpu";
import {
  getCatalog,
  resolveModelPath,
  resolveModelRef,
  deleteLocalModel as deleteLocalModelFromDisk,
} from "../electron/lib/models";
import { getLocalPaths, loadConfig, readLocalSettings, saveConfig } from "../electron/lib/paths";
import { resolveRepoHostPath } from "../shared/openPath";
import { loadRuntimeConfig, saveRuntimeConfig } from "../electron/lib/runtimeConfig";
import { loadServerConfig, saveServerConfig } from "../electron/lib/serverConfig";
import { evaluateGuardrails, effectiveGpuLayers } from "../electron/lib/vram";
import { DEFAULT_ENGINE, engineInfos, getEngine } from "../engines";
import * as chatService from "../electron/lib/chatService";
import { inferChatStream } from "../electron/lib/chatInfer";
import type { CreateServerRequest, EngineId, GpuInfo, GuardrailResult, InferenceBackend, StreamDelta, VramEstimate } from "../shared/types";
import { devicesForBackend, runtimeIndex, runtimeIndicesFromSelection, validateBackendDevices } from "../shared/gpuDevices";
import { metalEnabled } from "./hostAgent";
import { canDispatchOpenPath, dispatchOpenPath } from "./openPathDispatch";
import { serverManager } from "./serverManager";
import { hostPathsForDocker, runtimeHostOs } from "../shared/openPath";
import { restartOpenAiGateway } from "./openaiGateway";
import * as benchmarkRunner from "./benchmarkRunner";
import { defaultRuntimeMode, inComposeBackend } from "../shared/runtimeMode";
import { dockerHealth } from "./containerUtils";
import { probeNativeRuntime } from "./llamaServerBin";
import { probeMlxRuntime } from "./mlxServerBin";
import type { BenchmarkCategory } from "../shared/benchmarks/types";
import { loadSettings, saveSettings, jitStatusFromConfig } from "../electron/lib/settings";
import { bootstrapHfToken, clearHfToken, isHfTokenSet, setHfToken } from "../electron/lib/secrets";
import { hasApiKeyConfigured } from "./apiAuth";
import { searchModels, listRepoFiles } from "./hfHub";
import {
  cancelDownloadJob,
  getDownloadJob,
  listDownloadJobs,
  startDownload,
} from "./downloadJobs";
import {
  cancelRuntimeInstallJob,
  getRuntimeInstallJob,
  getRuntimesStatus,
  listRuntimeInstallJobs,
  startRuntimeInstall,
} from "./runtimeInstaller";
import { assertArtifactRelPath } from "./benchmarkStore";
import type { SettingsPatch, StartModelDownloadRequest, HubFormatFilter, RuntimeId } from "../shared/types";

type GpuDevices = GpuInfo["devices"];

function selectedDevices(
  gpu: GpuInfo,
  gpuDevices?: number[],
  backend?: string | null,
): GpuDevices {
  if (!gpu.available || gpu.devices.length === 0) return [];
  const pool =
    backend && backend !== "cpu" && backend !== "metal"
      ? devicesForBackend(gpu.devices, backend as InferenceBackend)
      : gpu.devices;
  const source = pool;
  if (!gpuDevices || gpuDevices.length === 0) return source;
  const byUnique = source.filter((d) => gpuDevices.includes(d.index));
  if (byUnique.length) return byUnique;
  if (backend && backend !== "cpu" && backend !== "metal") {
    const byRuntime = source.filter((d) => {
      const r = runtimeIndex(d, backend as InferenceBackend);
      return r != null && gpuDevices.includes(r);
    });
    if (byRuntime.length) return byRuntime;
  }
  return source;
}

function loadedModelIds(): string[] {
  return serverManager
    .listStatuses()
    .filter((s) => s.running && s.loaded?.modelId)
    .map((s) => s.loaded!.modelId);
}

function loadedModelHints(): string[] {
  const hints = new Set<string>();
  for (const s of serverManager.listStatuses()) {
    if (!s.running || !s.loaded) continue;
    hints.add(s.loaded.modelId);
    hints.add(s.loaded.modelPath);
    if (s.loaded.mmprojPath) hints.add(s.loaded.mmprojPath);
  }
  return [...hints];
}

export async function computeEstimate(opts: {
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
  guardrail: GuardrailResult;
}> {
  const key = opts.modelPath ?? opts.modelId;
  if (!key) throw new Error("modelId or modelPath required");

  const modelRef = resolveModelRef(key);
  const engineId = opts.engine ?? DEFAULT_ENGINE;
  const engine = getEngine(engineId);
  const gpu = await getGpuInfoAsync();
  const devices = selectedDevices(gpu, opts.gpuDevices, opts.backend);
  const deviceCount = opts.gpuDeviceCount ?? (devices.length || null);

  const { estimate, contextLength, modelMaxContext } = await engine.memory.estimate({
    model: modelRef,
    modelId: opts.modelId,
    contextLength: opts.contextLength,
    nGpuLayers: effectiveGpuLayers(opts.backend, opts.nGpuLayers),
    kvCacheDtype: opts.kvCacheDtype ?? loadRuntimeConfig().kvCacheDtype,
    backend: opts.backend,
    gpuDevices: devices.map((d) => ({
      index: d.index,
      freeBytes: d.freeBytes,
      totalBytes: d.totalBytes,
    })),
    gpuDeviceCount: deviceCount,
    engineConfig: opts.engineConfig,
  });

  const guardrail = evaluateGuardrails(estimate, readLocalSettings().modelLoadingGuardrails);
  return { estimate, contextLength, modelMaxContext, guardrail };
}

type LoadRequestOpts = {
  modelId: string;
  contextLength: number;
  nGpuLayers: number;
  force?: boolean;
  jit?: boolean;
};

async function prepareLoadRequest(opts: LoadRequestOpts) {
  const resolved = resolveModelPath(opts.modelId);
  const ctx = clampContextLength(opts.contextLength);

  if (!opts.force) {
    try {
      const { guardrail } = await computeEstimate({
        modelId: opts.modelId,
        contextLength: ctx,
        nGpuLayers: opts.nGpuLayers,
      });
      if (!guardrail.passes) {
        throw new Error(`GUARDRAIL_BLOCKED: ${guardrail.reason}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("GUARDRAIL_BLOCKED")) throw e;
    }
  }

  saveRuntimeConfig({
    contextLength: ctx,
    nGpuLayers: opts.nGpuLayers,
    backendId: "docker-llama-server",
    lastModelId: opts.modelId,
  });

  return {
    modelId: resolved.modelId,
    modelPath: resolved.path,
    contextLength: ctx,
    nGpuLayers: opts.nGpuLayers,
    mmprojPath: resolved.vision,
    force: opts.force,
  };
}

async function ensureModelForRequest(serverId?: string | null) {
  if (serverId) {
    await serverManager.ensureReady(serverId);
    return;
  }
  const running = serverManager.listStatuses().find((s) => s.running);
  if (running) {
    await serverManager.ensureReady(running.definition.id);
    return;
  }

  const cfg = loadServerConfig();
  if (!cfg.justInTimeModelLoading) throw new Error("No model loaded");
  const runtimeCfg = loadRuntimeConfig();
  if (!runtimeCfg.lastModelId) throw new Error("No model loaded (JIT: no previous model to load)");

  await serverManager.createAndStart({
    modelId: runtimeCfg.lastModelId,
    backend: "cuda",
    gpuDevices: [],
    contextLength: runtimeCfg.contextLength,
    nGpuLayers: runtimeCfg.nGpuLayers,
    force: true,
  });
}

async function prepareSendMessage(id: string, serverId?: string | null) {
  const conv = chatService.getConversationWithMessages(id)?.conversation;
  const effectiveServerId = serverId ?? conv?.serverId ?? null;
  await ensureModelForRequest(effectiveServerId);
  const target = await serverManager.inferTarget(effectiveServerId);
  const loaded = serverManager.getLoaded(effectiveServerId ?? undefined);
  const meta = chatService.currentModelMeta(loaded);
  meta.serverId = effectiveServerId ?? loaded?.serverId ?? null;
  return { target, meta, effectiveServerId };
}

export const handlers = {
  getPaths: () => ({
    ...getLocalPaths(),
    repoRoot: resolveRepoHostPath(),
    settings: readLocalSettings(),
    config: loadConfig(),
  }),
  getConfig: () => loadConfig(),
  setConfig: (patch: { modelsDir?: string; hubModelsDir?: string; localRoot?: string }) => {
    const current = loadConfig();
    return saveConfig({
      modelsDir: patch.modelsDir ?? current.modelsDir,
      hubModelsDir: patch.hubModelsDir ?? current.hubModelsDir,
      localRoot: patch.localRoot ?? current.localRoot,
    });
  },
  getSettings: () =>
    loadSettings({ hfTokenSet: isHfTokenSet(), hasApiKey: hasApiKeyConfigured() }),
  setSettings: async (patch: SettingsPatch) => {
    const next = saveSettings(patch);
    if (patch.gateway) await restartOpenAiGateway();
    return loadSettings({ hfTokenSet: isHfTokenSet(), hasApiKey: hasApiKeyConfigured() });
  },
  setHfToken: (token: string) => {
    setHfToken(token);
    return { hfTokenSet: isHfTokenSet() };
  },
  clearHfToken: () => {
    clearHfToken();
    return { hfTokenSet: false };
  },
  searchHubModels: async (
    query: string,
    filter?: HubFormatFilter,
    sort?: string,
  ) => searchModels({ query, filter: filter ?? "all", sort }),
  listHubRepoFiles: (repoId: string, revision?: string) => listRepoFiles(repoId, revision ?? "main"),
  startModelDownload: (req: StartModelDownloadRequest) => startDownload(req),
  listDownloads: () => listDownloadJobs(),
  getDownload: (jobId: string) => {
    const job = getDownloadJob(jobId);
    if (!job) throw new Error("Download job not found");
    return job;
  },
  cancelDownload: (jobId: string) => cancelDownloadJob(jobId),
  getRuntimesStatus: () => getRuntimesStatus(),
  installRuntime: (runtimeId: RuntimeId) => startRuntimeInstall(runtimeId),
  listRuntimeInstalls: () => listRuntimeInstallJobs(),
  getRuntimeInstall: (jobId: string) => {
    const job = getRuntimeInstallJob(jobId);
    if (!job) throw new Error("Runtime install job not found");
    return job;
  },
  cancelRuntimeInstall: (jobId: string) => cancelRuntimeInstallJob(jobId),
  getGpu: () => getGpuInfoAsync(),
  getPlatform: async () => {
    const metal = metalEnabled();
    const docker = await dockerHealth();
    const native = probeNativeRuntime();
    const mlx = probeMlxRuntime();
    const compose = inComposeBackend();
    return {
      host: compose ? ("compose" as const) : ("electron" as const),
      pathSettingsLocked: compose,
      macMetal: metal,
      dockerGpu: process.env.LLAMA_GPU === "1",
      docker: docker.available,
      dockerError: docker.error,
      native: native.available,
      nativeError: native.error,
      llamaServerBin: native.bin,
      nativeBackendPack: native.packId ?? null,
      mlx: mlx.available,
      mlxError: mlx.error,
      mlxPython: mlx.python,
      defaultRuntime: defaultRuntimeMode(),
      os: runtimeHostOs(),
      canOpenPath: canDispatchOpenPath(),
      hostPaths: hostPathsForDocker(loadConfig()),
    };
  },
  getMonitor: () => getMonitorSnapshotAsync(),
  getModels: () => getCatalog(loadedModelIds()),
  deleteLocalModel: (body: { id?: string }) => {
    const id = body?.id?.trim();
    if (!id) throw new Error("Model id required");
    deleteLocalModelFromDisk(id, loadedModelHints());
  },
  getEngines: () => engineInfos(),
  listServers: () => serverManager.listStatuses(),
  getServerConfig: () => loadServerConfig(),
  setServerConfig: async (patch: Parameters<typeof saveServerConfig>[0]) => {
    const next = saveServerConfig(patch);
    await restartOpenAiGateway();
    return next;
  },
  getRuntimeConfig: () => loadRuntimeConfig(),
  setRuntimeConfig: (patch: Parameters<typeof saveRuntimeConfig>[0]) => saveRuntimeConfig(patch),
  getServerStatus: async (serverId?: string) => {
    if (serverId) {
      const st = serverManager.getStatus(serverId);
      if (!st) throw new Error("Server not found");
      // Don't block UI polling on host-agent while restart is in flight.
      if (st.loadPhase !== "loading") {
        try {
          await serverManager.refreshServerLogs(serverId);
        } catch {
          /* host agent busy or unreachable */
        }
      }
      const latest = serverManager.getStatus(serverId)!;
      return {
        ...latest,
        jit: jitStatusFromConfig(),
        ttlExpiresAt: null,
        servers: serverManager.listStatuses(),
        activeCount: serverManager.overview().activeCount,
        primaryServerId: serverId,
      };
    }
    return serverManager.overview();
  },
  clearServerLogs: (serverId?: string) => {
    const id = serverId ?? serverManager.overview().primaryServerId;
    if (id) serverManager.clearLogs(id);
    return serverManager.overview();
  },
  pickModelFile: async () => null,
  estimateVram: async (opts: {
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
  }) => {
    const { estimate, contextLength, modelMaxContext, guardrail } = await computeEstimate(opts);
    return {
      estimate,
      contextLength,
      modelMaxContext,
      passesGuardrails: guardrail.passes,
      guardrail,
    };
  },
  createServer: async (opts: CreateServerRequest) => {
    const gpu = await getGpuInfoAsync();
    const gpuErr = validateBackendDevices(opts.backend, gpu.devices, opts.gpuDevices);
    if (gpuErr) throw new Error(gpuErr);
    const gpuDevices = runtimeIndicesFromSelection(gpu.devices, opts.gpuDevices, opts.backend);
    const createOpts = { ...opts, gpuDevices };
    if (!opts.force) {
      const { guardrail } = await computeEstimate({
        modelId: opts.modelId,
        engine: opts.engine,
        contextLength: opts.contextLength,
        nGpuLayers: opts.nGpuLayers,
        kvCacheDtype: opts.kvCacheDtype,
        gpuDeviceCount: opts.gpuDevices.length || undefined,
        gpuDevices: opts.gpuDevices,
        backend: opts.backend,
        engineConfig: opts.engineConfig,
      });
      if (!guardrail.passes) {
        throw new Error(`GUARDRAIL_BLOCKED: ${guardrail.reason}`);
      }
    }
    saveRuntimeConfig({
      contextLength: opts.contextLength,
      nGpuLayers: opts.nGpuLayers,
      kvCacheDtype: opts.kvCacheDtype,
      backendId: opts.backend,
      lastModelId: opts.modelId,
    });
    return serverManager.createAndStart(createOpts);
  },
  startServer: (serverId: string, force?: boolean) => serverManager.startServer(serverId, force),
  stopServer: (serverId: string) => serverManager.stopServer(serverId),
  deleteServer: (serverId: string) => serverManager.deleteServer(serverId),
  loadModel: async (opts: LoadRequestOpts) => {
    const prep = await prepareLoadRequest(opts);
    return serverManager.createAndStart({
      modelId: prep.modelId,
      backend: "cuda",
      gpuDevices: [],
      contextLength: prep.contextLength,
      nGpuLayers: prep.nGpuLayers,
      force: prep.force,
    });
  },
  loadModelFromPath: async (opts: {
    path: string;
    contextLength: number;
    nGpuLayers: number;
    force?: boolean;
  }) => {
    const prep = await prepareLoadRequest({ ...opts, modelId: opts.path });
    return serverManager.createAndStart({
      modelId: prep.modelId,
      backend: "cuda",
      gpuDevices: [],
      contextLength: prep.contextLength,
      nGpuLayers: prep.nGpuLayers,
      force: prep.force,
    });
  },
  unloadModel: () => serverManager.unloadAll(),
  chat: async (messages: Array<{ role: string; content: string }>, serverId?: string) => {
    await ensureModelForRequest(serverId);
    const target = await serverManager.inferTarget(serverId);
    const loaded = serverManager.getLoaded(serverId ?? undefined);
    return inferChatStream(messages, {
      ...target,
      contextLength: loaded?.contextLength,
      modelHints: [loaded?.modelId, loaded?.modelPath],
      onDelta: () => {},
    });
  },
  listConversations: () => chatService.listConversations(),
  createConversation: (meta: Parameters<typeof chatService.createConversation>[0] = {}) =>
    chatService.createConversation(meta),
  getConversation: (id: string) => {
    const detail = chatService.getConversationWithMessages(id);
    if (!detail) throw new Error("Conversation not found");
    return detail;
  },
  renameConversation: (id: string, title: string) => {
    const conv = chatService.renameConversation(id, title);
    if (!conv) throw new Error("Conversation not found");
    return conv;
  },
  deleteConversation: (id: string) => chatService.deleteConversation(id),
  updateConversationMeta: (id: string, meta: Parameters<typeof chatService.updateConversationMeta>[1]) => {
    const conv = chatService.updateConversationMeta(id, meta);
    if (!conv) throw new Error("Conversation not found");
    return conv;
  },
  sendMessage: async (
    id: string,
    content: string,
    serverId?: string | null,
    onDelta?: (delta: StreamDelta) => void,
    enableThinking?: boolean,
    signal?: AbortSignal,
  ) => {
    const { target, meta, effectiveServerId } = await prepareSendMessage(id, serverId);
    return chatService.sendMessage(
      id,
      content,
      (messages, deltaCb) =>
        inferChatStream(messages, {
          ...target,
          serverId: effectiveServerId ?? target.serverId,
          contextLength: meta.contextLength,
          enableThinking: enableThinking === true,
          modelHints: [meta.modelId, meta.modelPath, meta.modelDisplayName],
          onDelta: deltaCb ?? onDelta ?? (() => {}),
          signal,
        }),
      meta,
      onDelta,
    );
  },
  openPath: (p: string) => dispatchOpenPath(p),
  listBenchmarkDefinitions: () => benchmarkRunner.listBenchmarkDefinitions(),
  listBenchmarkRuns: () => benchmarkRunner.listBenchmarkRuns(),
  getBenchmarkRun: (id: string) => {
    const run = benchmarkRunner.getBenchmarkRun(id);
    if (!run) throw new Error("Benchmark run not found");
    return run;
  },
  startBenchmarkRun: (req: Parameters<typeof benchmarkRunner.startBenchmarkRun>[0]) =>
    benchmarkRunner.startBenchmarkRun(req),
  cancelBenchmarkRun: (id: string) => {
    benchmarkRunner.cancelBenchmarkRun(id);
    return benchmarkRunner.getBenchmarkRun(id);
  },
  deleteBenchmarkRun: (id: string) => benchmarkRunner.deleteBenchmarkRun(id),
  setBenchmarkHumanScore: (
    runId: string,
    testId: BenchmarkCategory,
    humanScore: number,
    humanMaxScore?: number,
    humanNotes?: string,
  ) => benchmarkRunner.setHumanScore(runId, testId, humanScore, humanMaxScore, humanNotes),
  getBenchmarkArtifact: (runId: string, relPath: string) => {
    try {
      assertArtifactRelPath(relPath);
    } catch {
      throw new Error("Artifact not found");
    }
    const buf = benchmarkRunner.getArtifactContent(runId, relPath);
    if (!buf) throw new Error("Artifact not found");
    return buf;
  },
  readBenchmarkArtifact: (runId: string, testId: string, filename: string) => {
    const buf = benchmarkRunner.getArtifactContent(runId, `${testId}/${filename}`);
    if (!buf) throw new Error("Artifact not found");
    return buf.toString("utf8");
  },
};
