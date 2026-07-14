import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LoadProgressBar from "./LoadProgressBar";
import {
  api,
  type CatalogModel,
  type CreateServerRequest,
  type EngineConfigField,
  type EngineId,
  type EngineInfo,
  type GpuInfo,
  type GpuMode,
  type InferenceBackend,
  type LoadProgress,
  type ServerConfig,
  type ServerInstanceStatus,
  type ServerStatus,
  type VramEstimate,
} from "../revolver";

type Props = {
  models: CatalogModel[];
  gpu: GpuInfo | null;
  serverStatus: ServerStatus | null;
  configVersion: number;
  busy: string;
  setBusy: (v: string) => void;
  onRefresh: () => void;
  onError: (msg: string) => void;
};

type View = "list" | "wizard" | "detail";
type WizardStep = "backend" | "gpu" | "model" | "engine" | "config" | "review";

const DOCKER_GPU_BACKENDS = new Set<InferenceBackend>(["cuda", "rocm", "vulkan"]);

const BACKENDS: { id: InferenceBackend; label: string; hint: string }[] = [
  { id: "metal", label: "Metal (macOS)", hint: "Apple Silicon GPU via native llama-server" },
  { id: "cuda", label: "CUDA", hint: "NVIDIA GPUs via llama.cpp CUDA backend" },
  { id: "rocm", label: "ROCm", hint: "AMD GPUs (ROCm image)" },
  { id: "vulkan", label: "Vulkan", hint: "Cross-vendor GPU via Vulkan" },
  { id: "cpu", label: "CPU", hint: "No GPU — runs on host CPU only" },
];

function availableBackends(macMetal: boolean, dockerGpu: boolean) {
  if (macMetal && !dockerGpu) return BACKENDS.filter((b) => !DOCKER_GPU_BACKENDS.has(b.id));
  if (dockerGpu) return BACKENDS.filter((b) => b.id !== "metal");
  return BACKENDS;
}

function defaultWizardBackend(
  macMetal: boolean,
  dockerGpu: boolean,
  gpuAvailable: boolean,
): InferenceBackend {
  if (macMetal && !dockerGpu) return "metal";
  return gpuAvailable ? "cuda" : "cpu";
}

const phaseLabel: Record<string, string> = {
  idle: "Idle",
  loading: "Loading…",
  ready: "Ready",
  inferring: "Generating",
};

function gb(n: number) {
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatCtx(n: number) {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
  return n.toLocaleString();
}

function formatSize(n: number) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function renderEngineField(
  field: EngineConfigField,
  value: unknown,
  onChange: (key: string, value: unknown) => void,
) {
  const id = `engine-${field.key}`;
  if (field.type === "boolean") {
    return (
      <label key={field.key} className="check-row span-2">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(field.key, e.target.checked)}
        />
        {field.label}
        {field.hint && <span className="field-hint">{field.hint}</span>}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label key={field.key}>
        {field.label}
        <select
          id={id}
          value={String(value ?? field.default)}
          onChange={(e) => onChange(field.key, e.target.value)}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.hint && <span className="field-hint">{field.hint}</span>}
      </label>
    );
  }
  return (
    <label key={field.key}>
      {field.label}
      <input
        id={id}
        type={field.type}
        value={Number(value ?? field.default)}
        min={field.min}
        max={field.max}
        step={field.step}
        onChange={(e) => onChange(field.key, Number(e.target.value))}
      />
      {field.hint && <span className="field-hint">{field.hint}</span>}
    </label>
  );
}

function modelKey(m: CatalogModel) {
  // HF catalog entries use repo id; path is for display/mounting only.
  if (m.source === "huggingface") return m.id;
  return m.path ?? m.id;
}

function contextPresets(modelMax: number | null): number[] {
  const base = [4096, 8192, 16384, 32768, 65536];
  const out = new Set(base);
  if (modelMax != null && modelMax > 0) out.add(modelMax);
  return [...out].sort((a, b) => a - b);
}

export default function ServerPanel({
  models,
  gpu,
  serverStatus,
  configVersion,
  busy,
  setBusy,
  onRefresh,
  onError,
}: Props) {
  const [view, setView] = useState<View>("list");
  const [wizardStep, setWizardStep] = useState<WizardStep>("backend");
  const [servers, setServers] = useState<ServerInstanceStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailStatus, setDetailStatus] = useState<ServerInstanceStatus | null>(null);

  const [backend, setBackend] = useState<InferenceBackend>("cuda");
  const [macMetal, setMacMetal] = useState(false);
  const [dockerGpu, setDockerGpu] = useState(false);
  const [gpuDevices, setGpuDevices] = useState<number[]>([]);
  const [gpuMode, setGpuMode] = useState<GpuMode>("single");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedHasWeights, setSelectedHasWeights] = useState(false);
  const [selectedModelFormat, setSelectedModelFormat] = useState<CatalogModel["format"]>(null);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engine, setEngine] = useState<EngineId>("llamacpp");
  const [engineConfig, setEngineConfig] = useState<Record<string, unknown>>({});
  const [serverName, setServerName] = useState("");
  const [contextLength, setContextLength] = useState(8192);
  const [gpuLayers, setGpuLayers] = useState(-1);
  const [kvDtype, setKvDtype] = useState("f16");
  const [vram, setVram] = useState<VramEstimate | null>(null);
  const [modelMaxCtx, setModelMaxCtx] = useState<number | null>(null);
  const [guardrailBlock, setGuardrailBlock] = useState("");
  const [serverDraft, setServerDraft] = useState<ServerConfig | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const serverLogRef = useRef<HTMLPreElement>(null);

  const wizardBackends = useMemo(
    () => availableBackends(macMetal, dockerGpu),
    [macMetal, dockerGpu],
  );

  const refreshServers = useCallback(async () => {
    const list = await api.listServers();
    setServers(list);
    return list;
  }, []);

  useEffect(() => {
    refreshServers().catch((e) => onError(String(e)));
    api.getEngines().then(setEngines).catch(() => {});
    api.getPlatform()
      .then((p) => {
        setMacMetal(p.macMetal);
        setDockerGpu(p.dockerGpu);
      })
      .catch(() => {});
    api.getServerConfig().then(setServerDraft);
  }, [configVersion, refreshServers, onError]);

  useEffect(() => {
    if (!macMetal || dockerGpu || !DOCKER_GPU_BACKENDS.has(backend)) return;
    setBackend("metal");
  }, [macMetal, dockerGpu, backend]);

  useEffect(() => {
    api.getRuntimeConfig().then((rt) => {
      setContextLength(rt.contextLength);
      setGpuLayers(rt.nGpuLayers);
      setKvDtype(rt.kvCacheDtype);
    });
  }, [configVersion]);

  useEffect(() => {
    if (view !== "detail" || !selectedId) return;
    const poll = () =>
      api.getServerStatus(selectedId).then((s) => {
        const inst = s.servers?.find((x) => x.definition.id === selectedId) ?? null;
        setDetailStatus(inst);
      });
    poll();
    const t = setInterval(poll, 800);
    return () => clearInterval(t);
  }, [view, selectedId, busy]);

  const selectedCatalogModel = useMemo(
    () => models.find((m) => modelKey(m) === selectedModel) ?? null,
    [models, selectedModel],
  );

  const compatibleEngines = useMemo(() => {
    if (!selectedCatalogModel) return engines;
    const ids = new Set(selectedCatalogModel.compatibleEngines);
    return engines.filter((e) => {
      if (!ids.has(e.id)) return false;
      if (backend === "metal") return e.capabilities.supportsMetal;
      if (backend === "cuda") return e.capabilities.supportsCUDA;
      if (backend === "rocm") return e.capabilities.supportsROCm;
      if (backend === "vulkan") return e.capabilities.supportsVulkan;
      if (backend === "cpu") return e.capabilities.supportsCPU;
      return true;
    });
  }, [engines, selectedCatalogModel, backend]);

  const activeEngineInfo = useMemo(
    () => compatibleEngines.find((e) => e.id === engine) ?? compatibleEngines[0] ?? null,
    [compatibleEngines, engine],
  );

  useEffect(() => {
    if (!compatibleEngines.length) return;
    if (!compatibleEngines.some((e) => e.id === engine)) {
      setEngine(compatibleEngines[0].id);
    }
  }, [compatibleEngines, engine]);

  useEffect(() => {
    if (!activeEngineInfo) return;
    const defaults: Record<string, unknown> = {};
    for (const field of activeEngineInfo.configFields) {
      defaults[field.key] = field.default;
    }
    setEngineConfig(defaults);
  }, [activeEngineInfo?.id]);

  useEffect(() => {
    if (!selectedModel || !selectedHasWeights) return;
    const t = setTimeout(async () => {
      try {
        const key = selectedModel.endsWith(".gguf")
          ? { modelPath: selectedModel }
          : { modelId: selectedModel };
        const est = await api.estimateVram({
          ...key,
          engine,
          contextLength,
          nGpuLayers: backend === "cpu" ? 0 : gpuLayers,
          kvCacheDtype: kvDtype,
          backend,
          engineConfig,
          gpuDeviceCount: gpuDevices.length || undefined,
          gpuDevices: gpuDevices.length ? gpuDevices : undefined,
        });
        setVram(est.estimate);
        setModelMaxCtx(est.modelMaxContext);
      } catch (e) {
        setVram(null);
        onError(String(e));
      }
    }, 200);
    return () => clearTimeout(t);
  }, [selectedModel, selectedHasWeights, contextLength, gpuLayers, kvDtype, backend, engine, engineConfig, gpuDevices.join(","), onError]);

  useEffect(() => {
    const logs = detailStatus?.containerLogs;
    if (logRef.current && logs?.length) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [detailStatus?.containerLogs]);

  useEffect(() => {
    const logs = detailStatus?.serverLogs;
    if (serverLogRef.current && logs?.length) {
      serverLogRef.current.scrollTop = serverLogRef.current.scrollHeight;
    }
  }, [detailStatus?.serverLogs]);

  const resetWizard = () => {
    setWizardStep("backend");
    setBackend(defaultWizardBackend(macMetal, dockerGpu, gpu?.available ?? false));
    setGpuDevices(gpu?.devices[0] != null ? [gpu.devices[0].index] : []);
    setGpuMode("single");
    setSelectedModel("");
    setSelectedHasWeights(false);
    setSelectedModelFormat(null);
    setEngine("llamacpp");
    setEngineConfig({});
    setServerName("");
    setGuardrailBlock("");
    setVram(null);
  };

  const openWizard = () => {
    resetWizard();
    setView("wizard");
  };

  const toggleGpu = (index: number) => {
    setGpuDevices((prev) => {
      if (prev.includes(index)) return prev.filter((i) => i !== index);
      if (prev.length >= 2) return [prev[1], index];
      return [...prev, index].sort((a, b) => a - b);
    });
  };

  const wizardSteps: WizardStep[] =
    backend === "cpu" || backend === "metal"
      ? ["backend", "model", "engine", "config", "review"]
      : ["backend", "gpu", "model", "engine", "config", "review"];

  const stepIndex = wizardSteps.indexOf(wizardStep);
  const canNext = () => {
    if (wizardStep === "backend") return true;
    if (wizardStep === "gpu") return backend === "cpu" || backend === "metal" || gpuDevices.length > 0;
    if (wizardStep === "model") return selectedModel && selectedHasWeights;
    if (wizardStep === "engine") return compatibleEngines.length > 0;
    if (wizardStep === "config") return true;
    return true;
  };

  const nextStep = () => {
    const idx = stepIndex;
    if (idx < wizardSteps.length - 1) setWizardStep(wizardSteps[idx + 1]);
  };

  const prevStep = () => {
    const idx = stepIndex;
    if (idx > 0) setWizardStep(wizardSteps[idx - 1]);
  };

  const waitForServer = async (serverId: string, engineId?: EngineId) => {
    const waitMs =
      engineId === "vllm-legacy" ? 960_000 : engineId === "vllm" ? 660_000 : 360_000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const s = await api.getServerStatus(serverId);
      const inst = s.servers?.find((x) => x.definition.id === serverId);
      if (inst?.loadError) throw new Error(inst.loadError);
      if (inst?.loadPhase === "ready" && inst.running) return inst;
      if (inst?.loadPhase !== "loading" && inst?.running) return inst;
      if (inst?.loadPhase === "idle" && inst.loadError) throw new Error(inst.loadError);
      await new Promise((r) => setTimeout(r, 500));
    }
    const last = await api.getServerStatus(serverId);
    const inst = last.servers?.find((x) => x.definition.id === serverId);
    if (inst?.loadError) throw new Error(inst.loadError);
    throw new Error("Timed out waiting for server start");
  };

  const startServer = async (force = false) => {
    if (!selectedModel) return;
    setBusy("create");
    onError("");
    setGuardrailBlock("");
    try {
      if (serverDraft) await api.setServerConfig(serverDraft);
      await api.setRuntimeConfig({ contextLength, nGpuLayers: gpuLayers, kvCacheDtype: kvDtype });
      const req: CreateServerRequest = {
        name: serverName.trim() || undefined,
        engine,
        backend,
        gpuDevices: backend === "cpu" || backend === "metal" ? [] : gpuDevices,
        gpuMode: gpuDevices.length >= 2 ? gpuMode : "single",
        modelId: selectedModel,
        contextLength,
        nGpuLayers: backend === "cpu" ? 0 : gpuLayers,
        kvCacheDtype: kvDtype,
        engineConfig,
        force,
      };
      const created = await api.createServer(req);
      const inst = await waitForServer(created.definition.id, engine);
      setSelectedId(inst.definition.id);
      setView("detail");
      await refreshServers();
      await onRefresh();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("GUARDRAIL_BLOCKED")) {
        setGuardrailBlock(msg.replace(/^.*GUARDRAIL_BLOCKED:\s*/, ""));
      } else {
        onError(msg);
      }
    } finally {
      setBusy("");
    }
  };

  const openDetail = (id: string) => {
    setSelectedId(id);
    setView("detail");
  };

  const displayContainerLogs =
    detailStatus?.containerLogs ??
    detailStatus?.logs?.filter((l) => l.startsWith("[revolver]")) ??
    [];
  const displayServerLogs = detailStatus?.serverLogs ?? [];

  const ctxSliderMax = modelMaxCtx && modelMaxCtx > 0 ? modelMaxCtx : 131072;
  const runningCount = servers.filter((s) => s.running).length;

  if (view === "wizard") {
    return (
      <div className="server-layout">
        <section className="panel wizard-panel">
          <div className="wizard-head">
            <button className="ghost" onClick={() => setView("list")}>
              ← Back
            </button>
            <h2>New server</h2>
            <div className="wizard-steps">
              {wizardSteps.map((s, i) => (
                <span key={s} className={`wizard-step ${i <= stepIndex ? "active" : ""} ${i === stepIndex ? "current" : ""}`}>
                  {s}
                </span>
              ))}
            </div>
          </div>

          {wizardStep === "backend" && (
            <div className="wizard-body">
              <p className="muted">Pick inference backend for this container.</p>
              <div className="backend-grid">
                {wizardBackends.map((b) => (
                  <button
                    key={b.id}
                    className={`backend-card ${backend === b.id ? "sel" : ""}`}
                    onClick={() => {
                      setBackend(b.id);
                      if (b.id === "cpu") setGpuDevices([]);
                    }}
                  >
                    <strong>{b.label}</strong>
                    <span>{b.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {wizardStep === "gpu" && (
            <div className="wizard-body">
              <p className="muted">Select one GPU per server, or two to combine VRAM for a larger model.</p>
              {!gpu?.available && <p className="field-hint warn">No GPU detected — pick CPU backend instead.</p>}
              <div className="gpu-grid">
                {gpu?.devices.map((d) => (
                  <button
                    key={d.index}
                    type="button"
                    className={`gpu-card selectable ${gpuDevices.includes(d.index) ? "sel" : ""}`}
                    onClick={() => toggleGpu(d.index)}
                  >
                    <strong>GPU {d.index}: {d.name}</strong>
                    <span>{d.freeGb.toFixed(1)} GB free / {d.totalGb.toFixed(1)} GB</span>
                  </button>
                ))}
              </div>
              {gpuDevices.length >= 2 && (
                <div className="gpu-mode-panel">
                  <label className="check-row">
                    <input
                      type="radio"
                      checked={gpuMode === "combined"}
                      onChange={() => setGpuMode("combined")}
                    />
                    Combine GPUs — split one large model across both devices
                  </label>
                  <label className="check-row">
                    <input
                      type="radio"
                      checked={gpuMode === "single"}
                      onChange={() => setGpuMode("single")}
                    />
                    Use GPU {gpuDevices[0]} only (second selection ignored)
                  </label>
                  <p className="field-hint">
                    To run two models in parallel on different GPUs, create two servers — one GPU each.
                  </p>
                </div>
              )}
            </div>
          )}

          {wizardStep === "model" && (
            <div className="wizard-body model-wizard-list">
              <div className="panel-head">
                <span>Model</span>
                <button
                  className="ghost"
                  onClick={async () => {
                    const path = await api.pickModelFile();
                    if (path) {
                      setSelectedModel(path);
                      setSelectedHasWeights(true);
                    }
                  }}
                >
                  Open GGUF…
                </button>
              </div>
              <div className="model-scroll">
                {models
                  .filter((m) => m.hasWeights)
                  .map((m) => {
                    const id = modelKey(m);
                    return (
                      <button
                        key={id}
                        className={`model-card ${selectedModel === id ? "sel" : ""}`}
                        onClick={() => {
                          setSelectedModel(id);
                          setSelectedHasWeights(true);
                          setSelectedModelFormat(m.format);
                          setServerName(m.displayName);
                        }}
                      >
                        <div className="model-title">{m.displayName}</div>
                        <div className="model-sub">{m.subtitle}</div>
                        <div className="model-meta">
                          {m.format && <span className="pill">{m.format}</span>}
                          {m.sizeBytes != null && <span>{formatSize(m.sizeBytes)}</span>}
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {wizardStep === "engine" && (
            <div className="wizard-body">
              <p className="muted">
                Pick inference engine for{" "}
                {selectedModelFormat ? `${selectedModelFormat.toUpperCase()} ` : ""}
                model.
              </p>
              {compatibleEngines.length === 0 ? (
                <p className="field-hint warn">No engines support this model on the selected backend.</p>
              ) : (
                <div className="backend-grid">
                  {compatibleEngines.map((e) => (
                    <button
                      key={e.id}
                      className={`backend-card ${engine === e.id ? "sel" : ""}`}
                      onClick={() => setEngine(e.id)}
                    >
                      <strong>{e.label}</strong>
                      <span>{e.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {wizardStep === "config" && (
            <div className="wizard-body">
              <div className="field-grid">
                <label className="span-2">
                  Server name
                  <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="My model server" />
                </label>
                <label className="span-2">
                  <span className="ctx-head">
                    <span>Context length</span>
                    <strong className="ctx-value">{contextLength.toLocaleString()} tokens</strong>
                  </span>
                  <input
                    className="ctx-slider"
                    type="range"
                    min={512}
                    max={ctxSliderMax}
                    step={512}
                    value={Math.min(contextLength, ctxSliderMax)}
                    onChange={(e) => setContextLength(Number(e.target.value))}
                  />
                  <div className="ctx-presets">
                    {contextPresets(modelMaxCtx).map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`ghost ${contextLength === n ? "active" : ""}`}
                        onClick={() => setContextLength(n)}
                      >
                        {formatCtx(n)}
                      </button>
                    ))}
                  </div>
                </label>
                {backend !== "cpu" && engine === "llamacpp" && (
                  <label>
                    GPU layers (-1 = all)
                    <input type="number" value={gpuLayers} onChange={(e) => setGpuLayers(Number(e.target.value))} />
                  </label>
                )}
                {engine === "llamacpp" && (
                  <label>
                    KV cache dtype
                    <select value={kvDtype} onChange={(e) => setKvDtype(e.target.value)}>
                      <option value="f16">f16</option>
                      <option value="f32">f32</option>
                      <option value="q8_0">q8_0</option>
                      <option value="q4_0">q4_0</option>
                    </select>
                  </label>
                )}
                {activeEngineInfo?.configFields.map((field) =>
                  renderEngineField(field, engineConfig[field.key], (key, value) =>
                    setEngineConfig((prev) => ({ ...prev, [key]: value })),
                  ),
                )}
              </div>
              {vram && (
                <div className="vram-panel compact">
                  <span>
                    Est. memory: {vram.totalGb} GB
                    {" "}
                    (model {(vram.modelVramBytes / 1024 ** 3).toFixed(2)} GB + context{" "}
                    {(vram.contextVramBytes / 1024 ** 3).toFixed(2)} GB)
                  </span>
                  {backend !== "cpu" && vram.peakGpuGb != null && (
                    <span className="muted small">
                      GPU peak ~{vram.peakGpuGb} GB
                    </span>
                  )}
                  {vram.fitsInVram === false && <span className="warn">May exceed VRAM</span>}
                </div>
              )}
            </div>
          )}

          {wizardStep === "review" && (
            <div className="wizard-body">
              <dl className="review-list">
                <dt>Backend</dt>
                <dd>{backend.toUpperCase()}</dd>
                <dt>Engine</dt>
                <dd>{activeEngineInfo?.label ?? engine}</dd>
                {backend !== "cpu" && (
                  <>
                    <dt>GPUs</dt>
                    <dd>
                      {gpuDevices.join(", ") || "none"}
                      {gpuDevices.length >= 2 && gpuMode === "combined" ? " (combined)" : ""}
                    </dd>
                  </>
                )}
                <dt>Model</dt>
                <dd>{selectedModel.split("/").pop()}</dd>
                <dt>Context</dt>
                <dd>{contextLength.toLocaleString()}</dd>
                <dt>Container</dt>
                <dd className="mono muted">New Docker container on next free port</dd>
              </dl>
              {guardrailBlock && (
                <div className="banner warn guardrail-block">
                  <span>Guardrail blocked: {guardrailBlock}</span>
                  <button className="primary" disabled={!!busy} onClick={() => startServer(true)}>
                    Start anyway
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="wizard-foot">
            <button disabled={stepIndex === 0} onClick={prevStep}>
              Previous
            </button>
            {wizardStep !== "review" ? (
              <button className="primary" disabled={!canNext()} onClick={nextStep}>
                Next
              </button>
            ) : (
              <button className="primary" disabled={!!busy} onClick={() => startServer(false)}>
                {busy === "create" ? "Starting container…" : "Start server"}
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (view === "detail" && selectedId && detailStatus) {
    const def = detailStatus.definition;
    const showLoadProgress = detailStatus.loadPhase === "loading" || busy === "create";
    const loadProgress: LoadProgress | null =
      detailStatus.loadProgress ??
      (showLoadProgress ? { percent: 5, stage: "Starting…", steps: [], elapsedMs: 0 } : null);

    return (
      <div className="server-layout">
        <section className="panel">
          <div className="panel-head">
            <button className="ghost" onClick={() => setView("list")}>
              ← All servers
            </button>
            <span className={`pill ${detailStatus.running ? "on" : ""}`}>
              {phaseLabel[detailStatus.loadPhase] ?? detailStatus.loadPhase}
            </span>
          </div>
          <h2>{def.name}</h2>
          <p className="mono muted">{def.modelPath}</p>
          <div className="status-row">
            <span className="pill">{def.backend.toUpperCase()}</span>
            <span className="pill">{def.engine ?? "llamacpp"}</span>
            {def.gpuDevices.length > 0 && (
              <span className="pill">
                GPU {def.gpuDevices.join(",")}
                {def.gpuMode === "combined" ? " combined" : ""}
              </span>
            )}
            <span className="muted mono">{detailStatus.baseUrl}</span>
          </div>
          {showLoadProgress && loadProgress && <LoadProgressBar progress={loadProgress} />}
          {detailStatus.loadError && <div className="banner error">{detailStatus.loadError}</div>}
          <div className="actions">
            <button
              disabled={!!busy || detailStatus.running}
              onClick={() => {
                setBusy("start");
                api
                  .startServer(def.id)
                  .then(() => waitForServer(def.id, def.engine))
                  .then(onRefresh)
                  .catch((e) => onError(String(e)))
                  .finally(() => setBusy(""));
              }}
            >
              Start
            </button>
            <button
              disabled={!!busy || !detailStatus.running}
              onClick={() =>
                api
                  .stopServer(def.id)
                  .then(refreshServers)
                  .then(onRefresh)
                  .catch((e) => onError(String(e)))
              }
            >
              Stop
            </button>
            <button
              className="warn-btn"
              disabled={!!busy}
              onClick={() => {
                if (!confirm(`Delete server "${def.name}" and remove its container?`)) return;
                api
                  .deleteServer(def.id)
                  .then(() => {
                    setView("list");
                    return refreshServers();
                  })
                  .then(onRefresh)
                  .catch((e) => onError(String(e)));
              }}
            >
              Delete
            </button>
          </div>
        </section>

        <details className="panel log-panel collapsible" open>
          <summary>
            <h3>Container logs</h3>
          </summary>
          <pre ref={logRef} className="log-view">
            {displayContainerLogs.join("\n") || "No logs yet."}
          </pre>
        </details>

        <details className="panel log-panel collapsible" open>
          <summary>
            <h3>Server logs</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Raw llama-server output (timing, slots, inference)
            </p>
          </summary>
          <pre ref={serverLogRef} className="log-view">
            {displayServerLogs.join("\n") || "No server output yet."}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <div className="server-layout">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 style={{ margin: 0 }}>Servers</h2>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              {runningCount} running · {servers.length} total
            </p>
          </div>
          <button className="primary" onClick={openWizard}>
            + New server
          </button>
        </div>

        {servers.length === 0 ? (
          <div className="empty-state">
            <p>No servers yet.</p>
            <p className="muted">Create a server to load a model in its own Docker container.</p>
            <button className="primary" onClick={openWizard}>
              New server
            </button>
          </div>
        ) : (
          <div className="server-grid">
            {servers.map((s) => {
              const d = s.definition;
              return (
                <button key={d.id} className="server-card" onClick={() => openDetail(d.id)}>
                  <div className="server-card-head">
                    <strong>{d.name}</strong>
                    <span className={`pill ${s.running ? "on" : ""}`}>
                      {s.running ? phaseLabel[s.loadPhase] : "Stopped"}
                    </span>
                  </div>
                  <div className="server-card-meta muted">
                    <span>{d.backend.toUpperCase()}</span>
                    <span>{d.engine ?? "llamacpp"}</span>
                    {d.gpuDevices.length > 0 && (
                      <span>
                        GPU {d.gpuDevices.join(",")}
                        {d.gpuMode === "combined" ? " · combined" : ""}
                      </span>
                    )}
                    <span className="mono">:{d.hostPort}</span>
                  </div>
                  <div className="server-card-model">{d.modelPath.split("/").pop()}</div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {serverStatus && serverStatus.activeCount != null && serverStatus.activeCount > 0 && (
        <section className="panel">
          <h3>Quick status</h3>
          <p className="muted">
            {serverStatus.activeCount} active server{serverStatus.activeCount !== 1 ? "s" : ""}
            {serverStatus.baseUrl && <> · primary at {serverStatus.baseUrl}</>}
          </p>
        </section>
      )}
    </div>
  );
}
