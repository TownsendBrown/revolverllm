import { ServerLogBuffer } from "../electron/lib/serverLogs";
import { existsSync } from "fs";
import { filterLogLines, parseLastSpeedTps, parseLoadProgress } from "../electron/lib/serverLogParse";
import { loadServerConfig, serverBaseUrl, serverEndpoints } from "../electron/lib/serverConfig";
import { generationTracker } from "../electron/lib/generation";
import { normalizeModelPath } from "../electron/lib/modelPaths";
import { resolveModelRef } from "../electron/lib/models";
import { getEngine } from "../engines";
import { chatTemplateSupportsReasoning } from "../shared/reasoning";
import { validateBackendDevices } from "../shared/gpuDevices";
import type { LoadedModelState, ServerDefinition, ServerInstanceStatus } from "../shared/types";
import {
  ensureServerRuntime,
  fetchServerLogs,
  getServerStartedAt,
  inspectServerPid,
  inspectServerStatus,
  restartServerRuntime,
  stopServerRuntime,
} from "./serverRuntime";
import { usesMetalHostAgent } from "./hostAgent";
import { isNativeRuntime } from "../shared/runtimeMode";
import { claimGpus, releaseGpus } from "./gpuClaims";
import { getGpuInfoAsync } from "./platformGpu";
import { clearLoadEnv, llamaConnectHost, writeLoadEnv } from "./containerUtils";
import { resolveInferenceModel } from "../electron/lib/chatInfer";

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type ServerPropsProbe = {
  supportsReasoning: boolean | null;
  nCtx: number | null;
};

async function probeServerProps(
  base: string,
  apiKey: string | null,
): Promise<ServerPropsProbe> {
  try {
    const res = await fetch(`${base}/props`, {
      signal: AbortSignal.timeout(3000),
      headers: authHeaders(apiKey),
    });
    if (res.status === 404) return { supportsReasoning: false, nCtx: null };
    if (!res.ok) return { supportsReasoning: null, nCtx: null };
    const body = (await res.json()) as {
      chat_template?: string;
      chat_template_caps?: Record<string, unknown>;
      default_generation_settings?: { n_ctx?: number };
    };
    const supportsReasoning = chatTemplateSupportsReasoning(
      body.chat_template,
      body.chat_template_caps,
    );
    const nCtx =
      typeof body.default_generation_settings?.n_ctx === "number" &&
      body.default_generation_settings.n_ctx > 0
        ? body.default_generation_settings.n_ctx
        : null;
    return { supportsReasoning, nCtx };
  } catch {
    return { supportsReasoning: null, nCtx: null };
  }
}

async function probeServerReady(base: string, apiKey: string | null): Promise<boolean> {
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
  def: ServerDefinition,
  base: string,
  apiKey: string | null,
  appendLog: (line: string) => void,
  fetchLogs: () => Promise<string[]>,
): Promise<void> {
  const engine = getEngine(def.engine);
  const spec = engine.readiness(def);
  const deadline = Date.now() + spec.timeoutMs;
  const seen = new Set<string>();
  const pollMs = spec.healthProbe
    ? (spec.healthProbeIntervalMs ?? 10_000)
    : 1_000;
  let lastHealthProbe = 0;

  while (Date.now() < deadline) {
    const dockerLogs = await fetchLogs();
    for (const line of dockerLogs) {
      if (seen.has(line)) continue;
      seen.add(line);
      appendLog(line);
    }

    for (const err of spec.errorMarkers) {
      if (dockerLogs.some((l) => l.includes(err.match))) {
        throw new Error(err.message);
      }
    }

    const now = Date.now();
    if (now - lastHealthProbe >= pollMs) {
      lastHealthProbe = now;
      if (await probeServerReady(base, apiKey)) return;
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Timed out waiting for model load (${Math.round(spec.timeoutMs / 60_000)} min). Check server logs.`);
}

/** Per-container inference server runtime. */
export class InstanceRuntime {
  private state: LoadedModelState | null = null;
  private loadStartedAt: number | null = null;
  private lastLoadError: string | null = null;
  private loadPromise: Promise<LoadedModelState> | null = null;
  private logs = new ServerLogBuffer();
  /** Latest raw docker logs from the inference container. */
  private serverLogLines: string[] = [];
  /** OpenAI model id for chat/completions (vLLM: from /v1/models; llama.cpp: local). */
  private inferenceModel: string | null = null;
  /** Cached from GET /props after a successful load. */
  private supportsReasoning: boolean | null = null;
  private nCtx: number | null = null;

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
    if (isNativeRuntime(this.def)) return "127.0.0.1";
    return llamaConnectHost();
  }

  getApiKey(): string | null {
    return this.def.apiKey ?? null;
  }

  getInferenceModel(): string {
    if (this.inferenceModel) return this.inferenceModel;
    if ((this.def.engine ?? "llamacpp") === "llamacpp") return "local";
    throw new Error("Inference model not resolved — reload the server");
  }

  async ensureInferenceModel(): Promise<string> {
    if (this.inferenceModel) return this.inferenceModel;
    if ((this.def.engine ?? "llamacpp") === "llamacpp") {
      this.inferenceModel = "local";
      return "local";
    }
    if (!this.isRunning()) throw new Error("No model loaded on selected server");
    await this.refreshInferenceModel();
    return this.inferenceModel!;
  }

  private async refreshInferenceModel(): Promise<void> {
    this.inferenceModel = await resolveInferenceModel(
      this.getHost(),
      this.getPort(),
      this.getApiKey(),
      this.def.engine ?? "llamacpp",
    );
  }

  markActivity(): void {
    /* TTL per-instance could be added later */
  }

  startLoad(opts?: { force?: boolean }): ServerInstanceStatus {
    this.lastLoadError = null;
    this.loadStartedAt = Date.now();
    this.logs.setLimit(loadServerConfig().logLinesLimit);
    const engine = getEngine(this.def.engine);
    this.logs.append(
      `[revolver] starting server "${this.def.name}" engine=${engine.id} backend=${this.def.backend}`,
    );
    this.loadPromise = this.loadInner(opts?.force)
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        this.lastLoadError = message;
        this.loadStartedAt = null;
        this.logs.append(`[revolver] load failed: ${message}`);
        throw e;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.status();
  }

  /** Verify server is reachable; reload if backend thinks running but process is gone. */
  async ensureReady(): Promise<void> {
    await this.syncHostProcessHealth();
    const base = `http://${this.getHost()}:${this.def.hostPort}`;
    if (this.isRunning() && (await probeServerReady(base, this.getApiKey()))) return;
    if (this.loadPromise) {
      await this.loadPromise;
      if (this.isRunning() && (await probeServerReady(base, this.getApiKey()))) return;
    }
    if (!this.def.modelPath) throw new Error("No model loaded on selected server");
    this.state = null;
    await this.loadInner(true);
  }

  /** Host-process liveness via PID. HTTP /health is only for load + chat (ensureReady). */
  private async syncHostProcessHealth(): Promise<void> {
    if ((!usesMetalHostAgent(this.def) && !isNativeRuntime(this.def)) || !this.state?.running) return;
    const pid = await inspectServerPid(this.def);
    if (pid != null && processAlive(pid)) return;
    this.state = null;
    this.lastLoadError = "inference server unreachable — reload required";
    this.logs.append("[revolver] inference server unreachable — marked idle");
  }

  private async loadInner(_force?: boolean): Promise<LoadedModelState> {
    const def = this.def;
    const engine = getEngine(def.engine);
    const modelRef = resolveModelRef(def.modelId);
    const compatErr = engine.validateModel(modelRef);
    if (compatErr) {
      this.loadStartedAt = null;
      throw new Error(compatErr);
    }
    if (!engine.supportsBackend(def.backend)) {
      this.loadStartedAt = null;
      throw new Error(`${engine.label} does not support backend ${def.backend}`);
    }
    if (def.backend !== "cpu") {
      const gpu = await getGpuInfoAsync();
      const gpuErr = validateBackendDevices(def.backend, gpu.devices, def.gpuDevices);
      if (gpuErr) {
        this.loadStartedAt = null;
        throw new Error(gpuErr);
      }
    }

    if (!def.modelPath && modelRef.source === "local") {
      this.loadStartedAt = null;
      throw new Error("modelPath missing");
    }

    if (modelRef.source === "local") {
      const modelPath = normalizeModelPath(def.modelPath);
      if (!existsSync(modelPath)) {
        this.loadStartedAt = null;
        throw new Error(`Model not found: ${def.modelPath} (resolved ${modelPath})`);
      }
    }

    await ensureServerRuntime(def);

    const plan = engine.buildLoadEnv({
      ...def,
      engineConfig: {
        ...def.engineConfig,
        modelFormat: modelRef.format,
        modelSource: modelRef.source,
      },
    });
    for (const line of plan.logLines) this.logs.append(line);
    if (usesMetalHostAgent(def)) {
      this.logs.append(`[revolver] metal host-agent → port ${def.hostPort}`);
    } else if (isNativeRuntime(def)) {
      const kind = def.engine === "mlx" ? "native revolver_mlx_server" : "native llama-server";
      this.logs.append(`[revolver] ${kind} → port ${def.hostPort}`);
    }
    if (def.gpuDevices.length) {
      this.logs.append(`[revolver] GPUs=${def.gpuDevices.join(",")} mode=${def.gpuMode}`);
    }

    const spec = engine.containerSpec(def);
    writeLoadEnv(spec.envFileName, plan.env);

    try {
      claimGpus(def, { force: _force });
      await restartServerRuntime(def);
    } catch (e) {
      releaseGpus(def.id);
      this.loadStartedAt = null;
      throw e;
    }

    const since = await getServerStartedAt(def);
    const base = `http://${this.getHost()}:${def.hostPort}`;
    try {
      await waitForModelReady(
        def,
        base,
        this.getApiKey(),
        (line) => this.logs.append(line),
        () => fetchServerLogs(def, { since }),
      );
    } catch (e) {
      releaseGpus(def.id);
      await stopServerRuntime(def).catch(() => {});
      this.loadStartedAt = null;
      this.lastLoadError = e instanceof Error ? e.message : String(e);
      throw e;
    }

    this.logs.append(`[revolver] ready on ${base}`);
    await this.refreshInferenceModel();
    this.logs.append(`[revolver] chat model=${this.inferenceModel}`);
    await this.refreshServerProps(base);
    await this.refreshServerLogs();

    this.state = await this.buildState();
    this.loadStartedAt = null;
    this.lastLoadError = null;
    return this.state;
  }

  private async refreshServerProps(base?: string): Promise<void> {
    if ((this.def.engine ?? "llamacpp") !== "llamacpp") {
      if (this.supportsReasoning != null) return;
      this.supportsReasoning = false;
      this.nCtx = this.def.contextLength;
      this.logs.append("[revolver] reasoning=not detected (engine has no /props)");
      return;
    }
    const url = base ?? `http://${this.getHost()}:${this.def.hostPort}`;
    const props = await probeServerProps(url, this.getApiKey());
    this.supportsReasoning = props.supportsReasoning;
    this.nCtx = props.nCtx;
    if (props.supportsReasoning != null) {
      this.logs.append(
        `[revolver] reasoning=${props.supportsReasoning ? "supported" : "not detected"} (from /props)`,
      );
    }
  }

  private async buildState(startedAt: string = new Date().toISOString()): Promise<LoadedModelState> {
    const def = this.def;
    const pid = await inspectServerPid(def);
    return {
      modelId: def.modelId,
      modelPath: def.modelPath,
      backendId: def.backend,
      contextLength: def.contextLength,
      nGpuLayers: def.nGpuLayers,
      port: def.hostPort,
      host: this.getHost(),
      pid,
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

  async adopt(): Promise<void> {
    if (!this.def.modelPath || this.state?.running) return;

    const hostProcess = usesMetalHostAgent(this.def) || isNativeRuntime(this.def);
    if (hostProcess) {
      const base = `http://${this.getHost()}:${this.def.hostPort}`;
      try {
        if (await probeServerReady(base, this.getApiKey())) {
          const startedAt = (await getServerStartedAt(this.def)) ?? undefined;
          this.state = await this.buildState(startedAt);
          claimGpus(this.def, { force: true });
          await this.refreshInferenceModel();
          await this.refreshServerProps(base);
          this.logs.append(`[revolver] adopted running server "${this.def.name}" on ${base}`);
        }
      } catch {
        return;
      }
      return;
    }

    let status: string;
    try {
      status = await inspectServerStatus(this.def);
    } catch {
      return;
    }
    if (status !== "running") return;

    const base = `http://${this.getHost()}:${this.def.hostPort}`;
    try {
      if (await probeServerReady(base, this.getApiKey())) {
        const startedAt = (await getServerStartedAt(this.def)) ?? undefined;
        this.state = await this.buildState(startedAt);
        claimGpus(this.def, { force: true });
        await this.refreshInferenceModel();
        await this.refreshServerProps(base);
        this.logs.append(`[revolver] adopted running server "${this.def.name}" on ${base}`);
      }
    } catch {
      return;
    }
  }

  async unload(): Promise<void> {
    const engine = getEngine(this.def.engine);
    const spec = engine.containerSpec(this.def);
    clearLoadEnv(spec.envFileName, engine.idleLoadEnv());
    this.state = null;
    this.loadStartedAt = null;
    this.lastLoadError = null;
    this.inferenceModel = null;
    this.supportsReasoning = null;
    this.nCtx = null;
    generationTracker.clear(this.def.id);
    this.logs.append(`[revolver] stopping server "${this.def.name}"`);
    await stopServerRuntime(this.def);
    releaseGpus(this.def.id);
  }

  async refreshServerLogs(): Promise<void> {
    const tail = loadServerConfig().logLinesLimit;
    const since = await getServerStartedAt(this.def);
    this.serverLogLines = await fetchServerLogs(this.def, { tail, since });
    await this.syncHostProcessHealth();
    // Retry /props once if we never got a reasoning signal (e.g. race at load).
    if (this.isRunning() && this.supportsReasoning == null) {
      await this.refreshServerProps();
    }
  }

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
    const loading = this.loadStartedAt != null;
    const containerLogs = lines.filter((l) => l.startsWith("[revolver]"));
    const serverLogs = loading
      ? lines.filter((l) => !l.startsWith("[revolver]"))
      : this.serverLogLines;
    const logSource = loading || !this.serverLogLines.length ? lines : this.serverLogLines;
    const host = this.getHost();
    const port = this.def.hostPort;
    const base = `http://${host}:${port}`;

    const generation = generationTracker.current(this.def.id);
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
          ? parseLoadProgress(logSource, true, "loading", this.loadStartedAt, this.def.engine)
          : null,
      lastSpeedTps: parseLastSpeedTps(logSource),
      port,
      host,
      baseUrl: base,
      gatewayUrl: serverBaseUrl(),
      endpoints: serverEndpoints(),
      logs: lines,
      logsFiltered: filterLogLines(lines, !cfg.verbose),
      containerLogs,
      serverLogs,
      generation,
      supportsReasoning: running ? this.supportsReasoning : null,
      nCtx: running ? this.nCtx : null,
    };
  }
}
