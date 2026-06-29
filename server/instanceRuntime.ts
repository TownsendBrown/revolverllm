import { ServerLogBuffer } from "../electron/lib/serverLogs";
import { existsSync } from "fs";
import { filterLogLines, parseLastSpeedTps, parseLoadProgress } from "../electron/lib/serverLogParse";
import { loadServerConfig, serverEndpoints } from "../electron/lib/serverConfig";
import { generationTracker } from "../electron/lib/generation";
import { LOAD_DEFAULTS } from "../electron/lib/localMeta";
import { normalizeModelPath, toContainerModelPath } from "../electron/lib/modelPaths";
import { effectiveGpuLayers } from "../electron/lib/vram";
import type { LoadedModelState, ServerDefinition, ServerInstanceStatus } from "../shared/types";
import {
  clearLoadEnv,
  ensureServerContainer,
  fetchContainerLogs,
  getContainerStartedAt,
  inspectContainerStatus,
  llamaConnectHost,
  relativeVisibleDevices,
  restartServerContainer,
  stopServerContainer,
  writeLoadEnv,
} from "./containerUtils";

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function probeLlamaReady(base: string, apiKey: string | null): Promise<boolean> {
  const headers = authHeaders(apiKey);
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
      headers,
    });
    if (health.ok) return true;
  } catch {
    /* try /v1/models next */
  }

  try {
    const models = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(2000),
      headers,
    });
    if (!models.ok) return false;
    const body = (await models.json()) as { data?: unknown[] };
    return (body.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function waitForModelReady(
  base: string,
  apiKey: string | null,
  appendLog: (line: string) => void,
  fetchLogs: () => Promise<string[]>,
): Promise<void> {
  const deadline = Date.now() + 300_000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const dockerLogs = await fetchLogs();
    for (const line of dockerLogs) {
      if (seen.has(line)) continue;
      seen.add(line);
      appendLog(line);
    }
    if (
      dockerLogs.some(
        (l) =>
          l.includes("model loaded") ||
          l.includes("server is listening") ||
          l.includes("HTTP server listening") ||
          l.includes("llama-server: model file not found"),
      )
    ) {
      if (dockerLogs.some((l) => l.includes("model file not found"))) {
        throw new Error("Model file not found inside container — check MODEL_PATH mount");
      }
      return;
    }

    if (await probeLlamaReady(base, apiKey)) return;

    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for model load (5 min). Check container logs.");
}

/** Per-container llama-server runtime. */
export class InstanceRuntime {
  private state: LoadedModelState | null = null;
  private loadStartedAt: number | null = null;
  private lastLoadError: string | null = null;
  private loadPromise: Promise<LoadedModelState> | null = null;
  private logs = new ServerLogBuffer();
  /** Latest raw docker logs from the llama-server container. */
  private serverLogLines: string[] = [];

  constructor(private def: ServerDefinition) {}

  get definition(): ServerDefinition {
    return this.def;
  }

  updateDefinition(def: ServerDefinition): void {
    this.def = def;
  }

  get loaded(): LoadedModelState | null {
    return this.isRunning() ? this.state : null;
  }

  isRunning(): boolean {
    return this.state?.running === true;
  }

  getPort(): number {
    return this.def.hostPort;
  }

  getHost(): string {
    return llamaConnectHost();
  }

  getApiKey(): string | null {
    return this.def.apiKey ?? null;
  }

  markActivity(): void {
    /* TTL per-instance could be added later */
  }

  startLoad(opts?: { force?: boolean }): ServerInstanceStatus {
    this.lastLoadError = null;
    this.loadStartedAt = Date.now();
    this.logs.setLimit(loadServerConfig().logLinesLimit);
    void this.loadInner(opts?.force).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      this.lastLoadError = message;
      this.loadStartedAt = null;
      this.logs.append(`[revolver] load failed: ${message}`);
    });
    return this.status();
  }

  private async loadInner(_force?: boolean): Promise<LoadedModelState> {
    const def = this.def;
    if (!def.modelPath) {
      this.loadStartedAt = null;
      throw new Error("modelPath missing");
    }

    const modelPath = normalizeModelPath(def.modelPath);
    if (!existsSync(modelPath)) {
      this.loadStartedAt = null;
      throw new Error(`Model not found: ${def.modelPath} (resolved ${modelPath})`);
    }
    const gpuLayers = effectiveGpuLayers(def.backend, def.nGpuLayers);

    await ensureServerContainer(def);

    this.logs.append(`[revolver] loading server "${def.name}" (${def.backend})`);
    this.logs.append(`[revolver] model=${modelPath} ctx=${def.contextLength} gpu_layers=${gpuLayers}`);
    this.logs.append(`[revolver] container path=${toContainerModelPath(modelPath)}`);
    if (def.gpuDevices.length) {
      this.logs.append(
        `[revolver] GPUs=${def.gpuDevices.join(",")} mode=${def.gpuMode}`,
      );
    }

    // KV cache quantization (anything other than f16) requires Flash Attention,
    // otherwise llama.cpp dequantizes every step and runs slower. Force `-fa on`
    // when quantizing; leave it on `auto` (llama.cpp default) for plain f16.
    const kvDtype = (def.kvCacheDtype || "f16").toLowerCase();
    const quantKv = kvDtype !== "f16";

    writeLoadEnv(def.id, {
      MODEL_PATH: modelPath,
      CTX_SIZE: def.contextLength,
      N_GPU_LAYERS: gpuLayers,
      LLAMA_HOST: "0.0.0.0",
      LLAMA_PORT: 8080,
      BACKEND: def.backend,
      MMPROJ_PATH: def.mmprojPath ? normalizeModelPath(def.mmprojPath) : undefined,
      FLASH_ATTN: quantKv ? "on" : "auto",
      CACHE_TYPE_K: quantKv ? kvDtype : undefined,
      CACHE_TYPE_V: quantKv ? kvDtype : undefined,
      // llama-server defaults (n_parallel=4, kv_unified=true, thinking=0).
      N_PARALLEL: LOAD_DEFAULTS.maxParallelPredictions,
      KV_UNIFIED: LOAD_DEFAULTS.useUnifiedKvCache ? "1" : undefined,
      // llama.cpp defaults to reasoning=auto, which enables `<|think|>` for gemma4
      // and burns tokens before the visible reply. Load with thinking=0.
      REASONING: "off",
      // Container-relative indices: `--gpus device=` already isolates the host
      // GPUs and renumbers them from 0, so host indices would point at nothing.
      CUDA_VISIBLE_DEVICES: def.gpuDevices.length ? relativeVisibleDevices(def) : undefined,
    });

    try {
      await restartServerContainer(def.id);
    } catch (e) {
      this.loadStartedAt = null;
      throw e;
    }

    // Bound readiness logs to this container start so a previous run's
    // "model loaded" line can't trigger a false-positive ready signal.
    const since = await getContainerStartedAt(def.id);

    const base = `http://${this.getHost()}:${def.hostPort}`;
    try {
      await waitForModelReady(
        base,
        this.getApiKey(),
        (line) => this.logs.append(line),
        () => fetchContainerLogs(def.id, { since }),
      );
    } catch (e) {
      this.loadStartedAt = null;
      this.lastLoadError = e instanceof Error ? e.message : String(e);
      throw e;
    }

    this.logs.append(`[revolver] ready on ${base}`);

    await this.refreshServerLogs();

    this.state = this.buildState();
    this.loadStartedAt = null;
    this.lastLoadError = null;
    return this.state;
  }

  private buildState(startedAt: string = new Date().toISOString()): LoadedModelState {
    const def = this.def;
    return {
      modelId: def.modelId,
      modelPath: def.modelPath,
      backendId: def.backend,
      contextLength: def.contextLength,
      nGpuLayers: def.nGpuLayers,
      port: def.hostPort,
      host: this.getHost(),
      pid: null,
      startedAt,
      mmprojPath: def.mmprojPath,
      running: true,
      jitLoaded: false,
      ttlSeconds: null,
      ttlExpiresAt: null,
      serverId: def.id,
      serverName: def.name,
      gpuDevices: def.gpuDevices,
      gpuMode: def.gpuMode,
    };
  }

  /**
   * Reconstruct running state from a live container on boot. A container can be
   * up but idle (no model env / still loading), so we only mark loaded when its
   * `/health` reports ready — otherwise we leave it idle.
   */
  async adopt(): Promise<void> {
    if (!this.def.modelPath || this.state?.running) return;
    let status: string;
    try {
      status = await inspectContainerStatus(this.def.id);
    } catch {
      return;
    }
    if (status !== "running") return;

    const base = `http://${this.getHost()}:${this.def.hostPort}`;
    try {
      if (await probeLlamaReady(base, this.getApiKey())) {
        const startedAt = (await getContainerStartedAt(this.def.id)) ?? undefined;
        this.state = this.buildState(startedAt);
        this.logs.append(`[revolver] adopted running server "${this.def.name}" on ${base}`);
      }
    } catch {
      return;
    }
  }

  async unload(): Promise<void> {
    clearLoadEnv(this.def.id);
    this.state = null;
    this.loadStartedAt = null;
    this.lastLoadError = null;
    this.logs.append(`[revolver] stopping server "${this.def.name}"`);
    await stopServerContainer(this.def.id);
  }

  async refreshServerLogs(): Promise<void> {
    const tail = loadServerConfig().logLinesLimit;
    const since = await getContainerStartedAt(this.def.id);
    this.serverLogLines = await fetchContainerLogs(this.def.id, { tail, since });
  }

  /** @deprecated use refreshServerLogs — kept for load-time log merge */
  async refreshLogs(): Promise<void> {
    await this.refreshServerLogs();
    for (const line of this.serverLogLines.slice(-50)) {
      this.logs.append(line);
    }
  }

  clearLogs(): void {
    this.logs.clear();
    this.serverLogLines = [];
  }

  status(): ServerInstanceStatus {
    const cfg = loadServerConfig();
    const running = this.isRunning();
    const lines = this.logs.getLines();
    const containerLogs = lines.filter((l) => l.startsWith("[revolver]"));
    const serverLogs = this.serverLogLines;
    const logSource = serverLogs.length ? serverLogs : lines;
    const host = this.getHost();
    const port = this.def.hostPort;
    const base = `http://${host}:${port}`;

    const generation = generationTracker.current;
    let loadPhase: ServerInstanceStatus["loadPhase"];
    if (this.loadStartedAt != null) {
      loadPhase = "loading";
    } else if (!running) {
      loadPhase = "idle";
    } else if (generation?.stage === "generating") {
      loadPhase = "inferring";
    } else {
      loadPhase = "ready";
    }

    return {
      definition: this.def,
      loaded: running ? this.state : null,
      running,
      loadPhase,
      loadError: this.lastLoadError,
      loadProgress:
        loadPhase === "loading"
          ? parseLoadProgress(logSource, true, "loading", this.loadStartedAt)
          : null,
      lastSpeedTps: parseLastSpeedTps(logSource),
      port,
      host,
      baseUrl: base,
      endpoints: serverEndpoints({ ...cfg, host, port }),
      logs: lines,
      logsFiltered: filterLogLines(lines, !cfg.verbose),
      containerLogs,
      serverLogs,
      generation,
    };
  }
}
