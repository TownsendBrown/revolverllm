import {
  createServerDefinition,
  getServerDefinition,
  listServerDefinitions,
  removeServerDefinition,
  saveServerDefinition,
} from "../electron/lib/serversStore";
import { resolveModelPath } from "../electron/lib/models";
import { clampContextLength } from "../electron/lib/contextLength";
import { effectiveGpuLayers } from "../electron/lib/vram";
import { loadRuntimeConfig } from "../electron/lib/runtimeConfig";
import type {
  CreateServerRequest,
  GpuMode,
  InferenceBackend,
  LoadedModelState,
  ServerDefinition,
  ServerInstanceStatus,
  ServersOverview,
} from "../shared/types";
import { removeServerRuntime } from "./serverRuntime";
import { InstanceRuntime } from "./instanceRuntime";

const runtimes = new Map<string, InstanceRuntime>();

function getRuntime(def: ServerDefinition): InstanceRuntime {
  let rt = runtimes.get(def.id);
  if (!rt) {
    rt = new InstanceRuntime(def);
    runtimes.set(def.id, rt);
  } else {
    rt.updateDefinition(def);
  }
  return rt;
}

function runtimeFor(id: string): InstanceRuntime | null {
  const def = getServerDefinition(id);
  if (!def) return null;
  return getRuntime(def);
}

function defaultGpuDevices(backend: InferenceBackend, devices: number[]): number[] {
  if (backend === "cpu" || backend === "metal") return [];
  return devices;
}

export const serverManager = {
  listDefinitions(): ServerDefinition[] {
    return listServerDefinitions();
  },

  listStatuses(): ServerInstanceStatus[] {
    return listServerDefinitions().map((def) => getRuntime(def).status());
  },

  getStatus(serverId: string): ServerInstanceStatus | null {
    return runtimeFor(serverId)?.status() ?? null;
  },

  overview(): ServersOverview {
    const servers = this.listStatuses();
    const running = servers.filter((s) => s.running);
    const primary = running[0] ?? servers.find((s) => s.loadPhase === "loading") ?? servers[0] ?? null;

    return {
      servers,
      activeCount: running.length,
      running: running.length > 0,
      loaded: primary?.loaded ?? null,
      loadPhase: primary?.loadPhase ?? "idle",
      loadError: primary?.loadError ?? null,
      loadProgress: primary?.loadProgress ?? null,
      lastSpeedTps: primary?.lastSpeedTps ?? null,
      port: primary?.port ?? 8082,
      host: primary?.host ?? "127.0.0.1",
      baseUrl: primary?.baseUrl ?? "",
      endpoints: primary?.endpoints ?? [],
      logs: primary?.logs ?? [],
      logsFiltered: primary?.logsFiltered ?? [],
      containerLogs: primary?.containerLogs ?? [],
      serverLogs: primary?.serverLogs ?? [],
      jit: { enabled: false, autoEvict: false, ttlSeconds: 0 },
      ttlExpiresAt: null,
      generation: primary?.generation ?? null,
      primaryServerId: primary?.definition.id ?? null,
    };
  },

  async createAndStart(req: CreateServerRequest): Promise<ServerInstanceStatus> {
    const resolved = resolveModelPath(req.modelId);
    const ctx = clampContextLength(req.contextLength);
    const rtCfg = loadRuntimeConfig();

    const gpuDevices = defaultGpuDevices(req.backend, req.gpuDevices);
    let gpuMode: GpuMode = req.gpuMode ?? "single";
    if (gpuDevices.length <= 1) gpuMode = "single";
    if (gpuDevices.length >= 2 && !req.gpuMode) gpuMode = "combined";
    const effectiveGpus =
      gpuMode === "single" && gpuDevices.length > 1 ? [gpuDevices[0]] : gpuDevices;

    const name =
      req.name?.trim() ||
      `${resolved.modelId.split("/").pop() ?? "model"} (${req.backend})`;

    const def = createServerDefinition({
      name,
      backend: req.backend,
      gpuDevices: effectiveGpus,
      gpuMode,
      modelId: resolved.modelId,
      modelPath: resolved.path,
      mmprojPath: resolved.vision,
      contextLength: ctx,
      nGpuLayers: effectiveGpuLayers(req.backend, req.nGpuLayers ?? rtCfg.nGpuLayers),
      kvCacheDtype: req.kvCacheDtype ?? rtCfg.kvCacheDtype,
      apiKey: req.apiKey ?? null,
    });

    const rt = getRuntime(def);
    return rt.startLoad({ force: req.force });
  },

  startServer(serverId: string, force?: boolean): ServerInstanceStatus {
    const rt = runtimeFor(serverId);
    if (!rt) throw new Error("Server not found");
    return rt.startLoad({ force });
  },

  async stopServer(serverId: string): Promise<void> {
    const rt = runtimeFor(serverId);
    if (!rt) throw new Error("Server not found");
    await rt.unload();
  },

  async deleteServer(serverId: string): Promise<void> {
    const def = getServerDefinition(serverId);
    const rt = runtimeFor(serverId);
    if (rt) {
      await rt.unload();
      runtimes.delete(serverId);
    }
    if (def) await removeServerRuntime(def);
    removeServerDefinition(serverId);
  },

  clearLogs(serverId: string): void {
    const rt = runtimeFor(serverId);
    if (!rt) throw new Error("Server not found");
    rt.clearLogs();
  },

  async refreshServerLogs(serverId: string): Promise<void> {
    const rt = runtimeFor(serverId);
    if (!rt) throw new Error("Server not found");
    await rt.refreshServerLogs();
  },

  getLoaded(serverId?: string): LoadedModelState | null {
    if (serverId) return runtimeFor(serverId)?.loaded ?? null;
    const running = this.listStatuses().find((s) => s.running);
    return running?.loaded ?? null;
  },

  async ensureReady(serverId: string): Promise<void> {
    const rt = runtimeFor(serverId);
    if (!rt) throw new Error("Server not found");
    await rt.ensureReady();
  },

  inferTarget(
    serverId?: string | null,
  ): { host: string; port: number; apiKey: string | null; markActivity: () => void } {
    let rt: InstanceRuntime | null = null;
    if (serverId) rt = runtimeFor(serverId);
    if (!rt) {
      const statuses = this.listStatuses().filter((s) => s.running);
      if (statuses.length === 1) {
        rt = runtimeFor(statuses[0].definition.id);
      } else if (statuses.length > 1) {
        throw new Error("Multiple servers running — select a server for this chat");
      }
    }
    if (!rt?.isRunning()) throw new Error("No model loaded on selected server");
    return {
      host: rt.getHost(),
      port: rt.getPort(),
      // Local test-chat authenticates with the container's own key when one is set,
      // so testing keeps working even on key-protected endpoints.
      apiKey: rt.getApiKey(),
      markActivity: () => rt!.markActivity(),
    };
  },

  /** Adopt already-running containers on boot so status survives backend restarts. */
  async reconcile(): Promise<void> {
    for (const def of listServerDefinitions()) {
      try {
        await getRuntime(def).adopt();
      } catch {
        /* leave idle if adoption fails */
      }
    }
  },

  /** Legacy: stop all servers */
  async unloadAll(): Promise<void> {
    for (const def of listServerDefinitions()) {
      const rt = runtimes.get(def.id);
      if (rt) await rt.unload();
    }
  },

  updateDefinition(serverId: string, patch: Partial<ServerDefinition>): ServerDefinition {
    const def = getServerDefinition(serverId);
    if (!def) throw new Error("Server not found");
    const updated = saveServerDefinition({
      ...def,
      ...patch,
      id: def.id,
      hostPort: def.hostPort,
      createdAt: def.createdAt,
      updatedAt: new Date().toISOString(),
    });
    getRuntime(updated).updateDefinition(updated);
    return updated;
  },
};
