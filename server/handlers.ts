import { statSync } from "fs";
import { clampContextLength, modelMaxContext } from "../electron/lib/contextLength";
import { getGpuInfoAsync, getMonitorSnapshotAsync } from "./platformGpu";
import {
  getCatalog,
  normalizeGgufMeta,
  readGgufMetadata,
  resolveModelPath,
} from "../electron/lib/models";
import { readHubMeta } from "../electron/lib/localMeta";
import { getLocalPaths, loadConfig, readLocalSettings, saveConfig } from "../electron/lib/paths";
import { resolveRepoHostPath } from "../shared/openPath";
import { loadRuntimeConfig, saveRuntimeConfig } from "../electron/lib/runtimeConfig";
import { loadServerConfig, saveServerConfig } from "../electron/lib/serverConfig";
import { estimateVram, evaluateGuardrails, effectiveGpuLayers } from "../electron/lib/vram";
import * as chatService from "../electron/lib/chatService";
import { inferChatStream } from "../electron/lib/chatInfer";
import type { CreateServerRequest, GpuInfo, GuardrailResult, VramEstimate } from "../electron/lib/types";
import { metalEnabled } from "./hostAgent";
import { canDispatchOpenPath, dispatchOpenPath } from "./openPathDispatch";
import { serverManager } from "./serverManager";
import { hostPathsForDocker, runtimeHostOs } from "../shared/openPath";

type GpuDevices = GpuInfo["devices"];

function selectedDevices(gpu: GpuInfo, gpuDevices?: number[]): GpuDevices {
  if (!gpu.available || gpu.devices.length === 0) return [];
  if (!gpuDevices || gpuDevices.length === 0) return gpu.devices;
  const sel = gpu.devices.filter((d) => gpuDevices.includes(d.index));
  return sel.length ? sel : gpu.devices;
}

function minGpuFreeBytes(devices: GpuDevices): number | null {
  if (devices.length === 0) return null;
  return Math.min(...devices.map((d) => d.freeBytes));
}

function minGpuCapacityBytes(devices: GpuDevices): number | null {
  if (devices.length === 0) return null;
  return Math.min(...devices.map((d) => d.totalBytes));
}

function loadedModelIds(): string[] {
  return serverManager
    .listStatuses()
    .filter((s) => s.running && s.loaded?.modelId)
    .map((s) => s.loaded!.modelId);
}

export async function computeEstimate(opts: {
  modelId?: string;
  modelPath?: string;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype?: string;
  gpuDeviceCount?: number;
  gpuDevices?: number[];
  backend?: string | null;
}): Promise<{
  estimate: VramEstimate;
  contextLength: number;
  modelMaxContext: number | null;
  guardrail: GuardrailResult;
}> {
  const key = opts.modelPath ?? opts.modelId;
  if (!key) throw new Error("modelId or modelPath required");
  const { path, vision, minMemoryBytes, contextLengths } = resolveModelPath(key);
  const meta = normalizeGgufMeta(await readGgufMetadata(path));
  const hubMeta = opts.modelId ? readHubMeta(opts.modelId) : null;
  const yamlMin = hubMeta?.minMemoryBytes ?? minMemoryBytes;
  const yamlCtx = hubMeta?.contextLengths.length ? hubMeta.contextLengths : contextLengths;
  const modelMax =
    modelMaxContext(yamlCtx) ??
    (Number(meta.context_length ?? meta.contextLength ?? 0) || null);
  const ctx = clampContextLength(opts.contextLength, modelMax);
  const gpu = await getGpuInfoAsync();
  const devices = selectedDevices(gpu, opts.gpuDevices);
  const deviceCount = opts.gpuDeviceCount ?? (devices.length || null);
  const scopedFree = devices.length ? devices.reduce((s, d) => s + d.freeBytes, 0) : null;
  const scopedCapacity = devices.length ? devices.reduce((s, d) => s + d.totalBytes, 0) : null;
  const estimate = estimateVram({
    modelFileBytes: statSync(path).size,
    ggufMeta: meta,
    contextLength: ctx,
    nGpuLayers: effectiveGpuLayers(opts.backend, opts.nGpuLayers),
    kvCacheDtype: opts.kvCacheDtype ?? loadRuntimeConfig().kvCacheDtype,
    visionAdapterBytes: vision ? statSync(vision).size : 0,
    minMemoryHintBytes: yamlMin,
    availableVramBytes: scopedFree,
    minGpuFreeBytes: minGpuFreeBytes(devices),
    capacityVramBytes: scopedCapacity,
    minGpuCapacityBytes: minGpuCapacityBytes(devices),
    gpuDeviceCount: deviceCount,
    backend: opts.backend,
  });
  const guardrail = evaluateGuardrails(estimate, readLocalSettings().modelLoadingGuardrails);
  return { estimate, contextLength: ctx, modelMaxContext: modelMax, guardrail };
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
  const target = serverManager.inferTarget(effectiveServerId);
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
  getGpu: () => getGpuInfoAsync(),
  getPlatform: () => {
    const metal = metalEnabled();
    return {
      macMetal: metal,
      dockerGpu: process.env.LLAMA_GPU === "1",
      os: runtimeHostOs(),
      canOpenPath: canDispatchOpenPath(),
      hostPaths: hostPathsForDocker(loadConfig()),
    };
  },
  getMonitor: () => getMonitorSnapshotAsync(),
  getModels: () => getCatalog(loadedModelIds()),
  listServers: () => serverManager.listStatuses(),
  getServerConfig: () => loadServerConfig(),
  setServerConfig: (patch: Parameters<typeof saveServerConfig>[0]) => saveServerConfig(patch),
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
        jit: { enabled: false, autoEvict: false, ttlSeconds: 0 },
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
    contextLength: number;
    nGpuLayers: number;
    kvCacheDtype?: string;
    gpuDeviceCount?: number;
    gpuDevices?: number[];
    backend?: string | null;
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
    if (!opts.force) {
      const { guardrail } = await computeEstimate({
        modelId: opts.modelId,
        contextLength: opts.contextLength,
        nGpuLayers: opts.nGpuLayers,
        kvCacheDtype: opts.kvCacheDtype,
        gpuDeviceCount: opts.gpuDevices.length || undefined,
        gpuDevices: opts.gpuDevices,
        backend: opts.backend,
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
    return serverManager.createAndStart(opts);
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
    const target = serverManager.inferTarget(serverId);
    return inferChatStream(messages, { ...target, onDelta: () => {} });
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
    onDelta?: (delta: string) => void,
  ) => {
    const { target, meta } = await prepareSendMessage(id, serverId);
    return chatService.sendMessage(
      id,
      content,
      (messages, deltaCb) =>
        inferChatStream(messages, {
          ...target,
          onDelta: deltaCb ?? onDelta ?? (() => {}),
        }),
      meta,
      onDelta,
    );
  },
  openPath: (p: string) => dispatchOpenPath(p),
};
