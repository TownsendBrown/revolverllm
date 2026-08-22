import {
  createServerDefinition,
  getServerDefinition,
  listServerDefinitions,
  removeServerDefinition,
  saveServerDefinition,
} from "../electron/lib/serversStore";
import { resolveModelPath, resolveModelRef } from "../electron/lib/models";
import { clampContextLength } from "../electron/lib/contextLength";
import { effectiveGpuLayers } from "../electron/lib/vram";
import { loadRuntimeConfig } from "../electron/lib/runtimeConfig";
import { loadServerConfig, serverBaseUrl, serverEndpoints } from "../electron/lib/serverConfig";
import { jitStatusFromConfig } from "../electron/lib/settings";
import { DEFAULT_ENGINE, getEngine } from "../engines";
import type {
  CreateServerRequest,
  EngineId,
  GpuMode,
  InferenceBackend,
  LoadedModelState,
  ServerDefinition,
  ServerInstanceStatus,
  ServersOverview,
} from "../shared/types";
import { defaultRuntimeMode, inComposeBackend } from "../shared/runtimeMode";
import { removeServerRuntime } from "./serverRuntime";
import { InstanceRuntime } from "./instanceRuntime";
import { probeNativeRuntime } from "./llamaServerBin";
import { probeMlxRuntime } from "./mlxServerBin";
import { getRuntimesStatus } from "./runtimeInstaller";
import { detectComputeCaps } from "./nativeBackends";
import { nativeSkuBlock } from "../shared/nativeRuntimeMatch";
import { getGpuInfoAsync } from "./platformGpu";
import {
  buildGatewayModelEntries,
  resolveGatewayRouteFromEntries,
  type GatewayModelEntry,
  type GatewayRoute,
} from "./gatewayRouting";

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

function runningRuntimes(): InstanceRuntime[] {
  return listServerDefinitions()
    .map((def) => getRuntime(def))
    .filter((rt) => rt.isRunning());
}

function runtimeFor(id: string): InstanceRuntime | null {
  const def = getServerDefinition(id);
  if (!def) return null;
  return getRuntime(def);
}

async function refreshGatewayRoutes(): Promise<GatewayRoute[]> {
  const routes: GatewayRoute[] = [];
  for (const rt of runningRuntimes()) {
    routes.push({
      host: rt.getHost(),
      port: rt.getPort(),
      upstreamModel: await rt.ensureInferenceModel(),
      apiKey: rt.getApiKey(),
      serverId: rt.definition.id,
      markActivity: () => rt.markActivity(),
    });
  }
  return routes;
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
    const gatewayUrl = serverBaseUrl();

    return {
      servers,
      activeCount: running.length,
      running: running.length > 0,
      loaded: primary?.loaded ?? null,
      loadPhase: primary?.loadPhase ?? "idle",
      loadError: primary?.loadError ?? null,
      loadProgress: primary?.loadProgress ?? null,
      lastSpeedTps: primary?.lastSpeedTps ?? null,
      port: loadServerConfig().port,
      host: loadServerConfig().host === "0.0.0.0" ? "127.0.0.1" : loadServerConfig().host,
      baseUrl: primary?.baseUrl ?? "",
      gatewayUrl,
      endpoints: serverEndpoints(),
      logs: primary?.logs ?? [],
      logsFiltered: primary?.logsFiltered ?? [],
      containerLogs: primary?.containerLogs ?? [],
      serverLogs: primary?.serverLogs ?? [],
      jit: jitStatusFromConfig(),
      ttlExpiresAt: null,
      generation: primary?.generation ?? null,
      primaryServerId: primary?.definition.id ?? null,
    };
  },

  async createAndStart(req: CreateServerRequest): Promise<ServerInstanceStatus> {
    const modelRef = resolveModelRef(req.modelId);
    const resolved = resolveModelPath(req.modelId);
    const engineId: EngineId = req.engine ?? DEFAULT_ENGINE;
    const engine = getEngine(engineId);

    const compatErr = engine.validateModel(modelRef);
    if (compatErr) throw new Error(compatErr);
    if (!engine.supportsBackend(req.backend)) {
      throw new Error(`${engine.label} does not support backend ${req.backend}`);
    }
    if (req.backend === "metal" && engineId !== "llamacpp" && engineId !== "mlx") {
      throw new Error("Metal backend only supports llama.cpp and MLX");
    }
    if (engineId === "mlx") {
      if (process.platform !== "darwin") {
        throw new Error("MLX is macOS only (Apple Silicon)");
      }
      if (inComposeBackend()) {
        throw new Error(
          "MLX requires a host process — run Electron on the Mac, not the Compose backend",
        );
      }
    }

    const runtime =
      engineId === "mlx"
        ? "native"
        : req.backend === "metal"
          ? undefined
          : (req.runtime ?? defaultRuntimeMode());
    if (runtime === "native") {
      if (!engine.capabilities.supportsNative) {
        throw new Error(`${engine.label} requires Docker — native runtime is llama.cpp / MLX only`);
      }
      if (engineId === "mlx") {
        const mlx = probeMlxRuntime();
        if (!mlx.available) throw new Error(mlx.error ?? "mlx-engine runtime is not available");
      } else {
        const probe = probeNativeRuntime(undefined, { backend: req.backend });
        if (!probe.available) throw new Error(probe.error ?? "Native llama-server is not available");
        if (process.platform === "linux" || process.platform === "win32") {
          const rt = getRuntimesStatus();
          const installed =
            process.platform === "win32"
              ? rt.win.filter((s) => s.installed).map((s) => s.id)
              : rt.linux.filter((s) => s.installed).map((s) => s.id);
          const gpu = await getGpuInfoAsync();
          const err = nativeSkuBlock(req.backend, {
            installed,
            computeCaps: detectComputeCaps(),
            devices: gpu.devices,
          });
          if (err) throw new Error(err);
        }
      }
    }

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
      `${resolved.modelId.split("/").pop() ?? "model"} (${engine.label}/${req.backend})`;

    const def = createServerDefinition({
      name,
      engine: engineId,
      backend: req.backend,
      runtime,
      gpuDevices: effectiveGpus,
      gpuMode,
      modelId: resolved.modelId,
      modelPath: resolved.path,
      mmprojPath: resolved.vision,
      contextLength: ctx,
      nGpuLayers: effectiveGpuLayers(req.backend, req.nGpuLayers ?? rtCfg.nGpuLayers),
      kvCacheDtype: req.kvCacheDtype ?? rtCfg.kvCacheDtype,
      engineConfig: req.engineConfig,
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

  async inferTarget(
    serverId?: string | null,
  ): Promise<{
    host: string;
    port: number;
    model: string;
    apiKey: string | null;
    serverId: string;
    markActivity: () => void;
  }> {
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
    const model = await rt.ensureInferenceModel();
    const id = rt.definition.id;
    return {
      host: rt.getHost(),
      port: rt.getPort(),
      model,
      apiKey: rt.getApiKey(),
      serverId: id,
      markActivity: () => rt!.markActivity(),
    };
  },

  async listGatewayModels(): Promise<GatewayModelEntry[]> {
    return buildGatewayModelEntries(runningRuntimes());
  },

  async resolveGateway(model?: string | null): Promise<{
    route: GatewayRoute;
    entries: GatewayModelEntry[];
  }> {
    const runtimes = runningRuntimes();
    const entries = await buildGatewayModelEntries(runtimes);
    const routes = await refreshGatewayRoutes();
    const route = resolveGatewayRouteFromEntries(entries, routes, model);
    return { route, entries };
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
