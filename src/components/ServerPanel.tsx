import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LoadProgressBar from "./LoadProgressBar";
import { useStickyScroll } from "../lib/useStickyScroll";
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
  type ServerRuntimeMode,
  type ServerStatus,
  type VramEstimate,
} from "../revolver";
import {
  backendGpuHint,
  deviceUsableForBackend,
  devicesForBackend,
  incompatibleDeviceReason,
  recommendedWizardBackend,
  runtimeIndex,
  validateBackendDevices,
  vendorLabel,
} from "../../shared/gpuDevices";

type Props = {
  models: CatalogModel[];
  gpu: GpuInfo | null;
  serverStatus: ServerStatus | null;
  configVersion: number;
  busy: string;
  setBusy: (v: string) => void;
  onRefresh: () => void;
  onError: (msg: string) => void;
  onServerReady?: (serverId: string) => void;
};

type View = "list" | "wizard" | "detail";
type WizardStep = "backend" | "gpu" | "model" | "engine" | "config" | "review";

const DOCKER_GPU_BACKENDS = new Set<InferenceBackend>(["cuda", "rocm", "vulkan"]);

const BACKENDS: { id: InferenceBackend; label: string; hint: string }[] = [
  { id: "metal", label: "Metal (macOS)", hint: "Apple Silicon GPU via llama-server or MLX" },
  { id: "cuda", label: "CUDA", hint: "NVIDIA GPUs via llama.cpp CUDA backend" },
  { id: "rocm", label: "ROCm", hint: "AMD GPUs (gfx1030+). Navi 10 / RX 5700 XT: use Vulkan" },
  { id: "vulkan", label: "Vulkan", hint: "AMD, Intel, and NVIDIA via Vulkan (RADV for RX 5700 XT)" },
  { id: "cpu", label: "CPU", hint: "No GPU — runs on host CPU only" },
];

function initialWizardRuntime(opts: {
  defaultRuntime?: ServerRuntimeMode;
  native: boolean;
  docker: boolean;
}): ServerRuntimeMode {
  if (opts.defaultRuntime === "native" && opts.native) return "native";
  if (opts.native && !opts.docker) return "native";
  return "docker";
}

function availableBackends(hostOs: string, macMetal: boolean, dockerGpu: boolean) {
  // macOS has no CUDA / ROCm / Vulkan runtime — Metal or CPU only.
  if (hostOs === "darwin") return BACKENDS.filter((b) => b.id === "metal" || b.id === "cpu");
  if (macMetal && !dockerGpu) return BACKENDS.filter((b) => !DOCKER_GPU_BACKENDS.has(b.id));
  if (dockerGpu) return BACKENDS.filter((b) => b.id !== "metal");
  return BACKENDS.filter((b) => b.id !== "metal");
}

function defaultWizardBackend(
  macMetal: boolean,
  dockerGpu: boolean,
  gpu: GpuInfo | null,
): InferenceBackend {
  return recommendedWizardBackend(macMetal, dockerGpu, gpu);
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
  if (field.type === "text") {
    return (
      <label key={field.key} className="span-2">
        {field.label}
        <input
          id={id}
          type="text"
          value={String(value ?? field.default ?? "")}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
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
  onServerReady,
}: Props) {
  const [view, setView] = useState<View>("list");
  const [wizardStep, setWizardStep] = useState<WizardStep>("backend");
  const [servers, setServers] = useState<ServerInstanceStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailStatus, setDetailStatus] = useState<ServerInstanceStatus | null>(null);

  const [backend, setBackend] = useState<InferenceBackend>("cuda");
  const [runtime, setRuntime] = useState<ServerRuntimeMode>("docker");
  const [macMetal, setMacMetal] = useState(false);
  const [dockerGpu, setDockerGpu] = useState(false);
  const [dockerAvailable, setDockerAvailable] = useState(true);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativeError, setNativeError] = useState<string | undefined>();
  const [nativeBackendPack, setNativeBackendPack] = useState<string | null>(null);
  const [mlxAvailable, setMlxAvailable] = useState(false);
  const [mlxError, setMlxError] = useState<string | undefined>();
  const [hostOs, setHostOs] = useState<string>("other");
  const [defaultRuntime, setDefaultRuntime] = useState<ServerRuntimeMode>("docker");
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const serverLogRef = useRef<HTMLPreElement>(null);

  // On macOS the native supervisor spawns llama-server / MLX with Metal
  // directly, so Metal is available with or without the host agent.
  const metalHost = macMetal || hostOs === "darwin";

  const wizardBackends = useMemo(
    () => availableBackends(hostOs, macMetal, dockerGpu),
    [hostOs, macMetal, dockerGpu],
  );

  const compatibleGpus = useMemo(
    () => devicesForBackend(gpu?.devices ?? [], backend),
    [gpu, backend],
  );

  const gpuHint = useMemo(
    () => backendGpuHint(backend, gpu?.devices ?? []),
    [backend, gpu],
  );

  const backendBlock = useMemo(
    () => validateBackendDevices(backend, gpu?.devices ?? []),
    [backend, gpu],
  );

  const recBackend = useMemo(
    () => recommendedWizardBackend(metalHost, dockerGpu, gpu),
    [metalHost, dockerGpu, gpu],
  );

  const refreshServers = useCallback(async () => {
    const list = await api.listServers();
    setServers(list);
    return list;
  }, []);

  useEffect(() => {
    if (serverStatus?.servers) setServers(serverStatus.servers);
  }, [serverStatus?.servers]);

  useEffect(() => {
    refreshServers().catch((e) => onError(String(e)));
    api.getEngines().then(setEngines).catch(() => {});
    api.getPlatform()
      .then((p) => {
        setMacMetal(p.macMetal);
        setDockerGpu(p.dockerGpu);
        setDockerAvailable(p.docker);
        setNativeAvailable(p.native);
        setNativeError(p.nativeError);
        setNativeBackendPack(p.nativeBackendPack ?? null);
        setMlxAvailable(p.mlx);
        setMlxError(p.mlxError);
        setHostOs(p.os);
        const next =
          p.os === "darwin"
            ? "native"
            : initialWizardRuntime({
                defaultRuntime: p.defaultRuntime,
                native: p.native,
                docker: p.docker,
              });
        setDefaultRuntime(next);
        setRuntime(next);
      })
      .catch(() => {});
    api.getServerConfig().then(setServerDraft);
  }, [configVersion, refreshServers, onError]);

  useEffect(() => {
    if (!metalHost || dockerGpu || !DOCKER_GPU_BACKENDS.has(backend)) return;
    setBackend("metal");
  }, [metalHost, dockerGpu, backend]);

  useEffect(() => {
    const err = validateBackendDevices(backend, gpu?.devices ?? []);
    if (!err) return;
    const rec = recommendedWizardBackend(metalHost, dockerGpu, gpu);
    if (rec !== backend) setBackend(rec);
  }, [backend, gpu, metalHost, dockerGpu]);

  useEffect(() => {
    if (backend === "cpu" || backend === "metal") {
      setGpuDevices([]);
      return;
    }
    setGpuDevices((prev) => {
      const keep = prev.filter((i) => compatibleGpus.some((d) => d.index === i));
      if (keep.length) return keep;
      return compatibleGpus[0] != null ? [compatibleGpus[0].index] : [];
    });
  }, [backend, compatibleGpus]);

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
    const ids = selectedCatalogModel ? new Set(selectedCatalogModel.compatibleEngines) : null;
    return engines.filter((e) => {
      if (ids && !ids.has(e.id)) return false;
      if (e.id === "mlx") {
        if (hostOs !== "darwin") return false;
        return backend === "metal" || backend === "cpu";
      }
      if (runtime === "native") return e.capabilities.supportsNative;
      if (backend === "metal") return e.capabilities.supportsMetal;
      if (backend === "cuda") return e.capabilities.supportsCUDA;
      if (backend === "rocm") return e.capabilities.supportsROCm;
      if (backend === "vulkan") return e.capabilities.supportsVulkan;
      if (backend === "cpu") return e.capabilities.supportsCPU;
      return true;
    });
  }, [engines, selectedCatalogModel, backend, runtime, hostOs]);

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

  const logsActive = view === "detail" && !!selectedId && !!detailStatus;
  useStickyScroll(logRef, [detailStatus?.containerLogs], {
    resetKey: selectedId,
    enabled: logsActive,
  });
  useStickyScroll(serverLogRef, [detailStatus?.serverLogs], {
    resetKey: selectedId,
    enabled: logsActive,
  });

  const resetWizard = () => {
    setWizardStep("backend");
    setBackend(defaultWizardBackend(metalHost, dockerGpu, gpu));
    const rec = recommendedWizardBackend(metalHost, dockerGpu, gpu);
    const pool = devicesForBackend(gpu?.devices ?? [], rec);
    setGpuDevices(pool[0] != null ? [pool[0].index] : []);
    setGpuMode("single");
    setRuntime(defaultRuntime);
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

  const claimedServerForDevice = (d: { index: number }) => {
    const device = gpu?.devices.find((x) => x.index === d.index);
    if (!device) return undefined;
    const ri = runtimeIndex(device, backend);
    if (ri == null) return undefined;
    return servers.find(
      (s) =>
        s.running &&
        s.definition.backend === backend &&
        s.definition.gpuDevices.includes(ri),
    );
  };

  const stepIndex = wizardSteps.indexOf(wizardStep);
  const canNext = () => {
    if (wizardStep === "backend") {
      if (backendBlock) return false;
      if (backend === "metal") return true;
      if (runtime === "native") return nativeAvailable;
      return dockerAvailable;
    }
    if (wizardStep === "gpu") {
      if (backend === "cpu" || backend === "metal") return true;
      if (!gpuDevices.length) return false;
      return gpuDevices.every((i) => {
        const d = gpu?.devices.find((x) => x.index === i);
        return d != null && deviceUsableForBackend(d, backend);
      });
    }
    if (wizardStep === "model") return selectedModel && selectedHasWeights;
    if (wizardStep === "engine") {
      if (!compatibleEngines.length) return false;
      if (engine === "mlx" && !mlxAvailable) return false;
      return true;
    }
    if (wizardStep === "config") return true;
    return !validateBackendDevices(backend, gpu?.devices ?? [], gpuDevices);
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
        backend: engine === "mlx" ? (backend === "cpu" ? "cpu" : "metal") : backend,
        runtime: engine === "mlx" ? "native" : backend === "metal" ? undefined : runtime,
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
      setSelectedId(created.definition.id);
      setDetailStatus(created);
      setView("detail");
      onServerReady?.(created.definition.id);
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

  useEffect(() => {
    if (view !== "detail") setConfirmDelete(false);
  }, [view]);

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
              <p className="muted">Pick inference backend for this server.</p>
              <div className="backend-grid">
                {wizardBackends.map((b) => {
                  const blocked = validateBackendDevices(b.id, gpu?.devices ?? []);
                  return (
                  <button
                    key={b.id}
                    type="button"
                    disabled={!!blocked}
                    className={`backend-card ${backend === b.id ? "sel" : ""} ${recBackend === b.id ? "recommend" : ""} ${blocked ? "blocked" : ""}`}
                    onClick={() => {
                      if (blocked) return;
                      setBackend(b.id);
                      if (b.id === "cpu") setGpuDevices([]);
                    }}
                  >
                    <strong>{b.label}</strong>
                    <span>{b.hint}</span>
                    {recBackend === b.id && !blocked && <span className="backend-rec">Recommended</span>}
                    {blocked && <span className="field-hint warn">{blocked}</span>}
                  </button>
                  );
                })}
              </div>
              {backend !== "metal" && hostOs !== "darwin" && (
                <>
                  <p className="muted" style={{ marginTop: "1.25rem" }}>
                    How to run llama-server
                  </p>
                  <div className="backend-grid">
                    <button
                      type="button"
                      disabled={!dockerAvailable}
                      className={`backend-card ${runtime === "docker" ? "sel" : ""} ${!dockerAvailable ? "blocked" : ""}`}
                      onClick={() => dockerAvailable && setRuntime("docker")}
                    >
                      <strong>Docker</strong>
                      <span>Official llama.cpp / vLLM images. Isolates CUDA toolkit.</span>
                      {!dockerAvailable && <span className="field-hint warn">Docker daemon not reachable</span>}
                    </button>
                    <button
                      type="button"
                      disabled={!nativeAvailable}
                      className={`backend-card ${runtime === "native" ? "sel" : ""} ${!nativeAvailable ? "blocked" : ""}`}
                      onClick={() => nativeAvailable && setRuntime("native")}
                    >
                      <strong>Native process</strong>
                      <span>Host llama-server. One process per server, pin GPUs with CUDA_VISIBLE_DEVICES.</span>
                      {nativeAvailable && <span className="backend-rec">No Docker{nativeBackendPack ? ` · ${nativeBackendPack}` : ""}</span>}
                      {!nativeAvailable && (
                        <span className="field-hint warn">{nativeError ?? "llama-server not found"}</span>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {wizardStep === "gpu" && (
            <div className="wizard-body">
              <p className="muted">Select one GPU per server, or two to combine VRAM for a larger model.</p>
              {gpuHint && <p className="field-hint warn">{gpuHint}</p>}
              {!gpu?.available && !gpuHint && (
                <p className="field-hint warn">No GPU detected — pick CPU backend instead.</p>
              )}
              <div className="gpu-grid">
                {(gpu?.devices ?? []).map((d) => {
                  const blocked = !deviceUsableForBackend(d, backend);
                  const reason = blocked ? incompatibleDeviceReason(d, backend) : null;
                  const claimed = !blocked ? claimedServerForDevice(d) : undefined;
                  return (
                  <button
                    key={`${d.vendor}-${d.index}`}
                    type="button"
                    disabled={blocked || !!claimed}
                    className={`gpu-card selectable ${gpuDevices.includes(d.index) ? "sel" : ""} ${blocked || claimed ? "blocked" : ""}`}
                    onClick={() => {
                      if (!blocked && !claimed) toggleGpu(d.index);
                    }}
                  >
                    <strong>
                      GPU {d.index}: {d.name}{" "}
                      <span className={`gpu-vendor ${d.vendor}`}>{vendorLabel(d.vendor)}</span>
                    </strong>
                    <span>{d.freeGb.toFixed(1)} GB free / {d.totalGb.toFixed(1)} GB</span>
                    {reason && <span className="field-hint warn">{reason}</span>}
                    {claimed && (
                      <span className="field-hint warn">
                        In use: {claimed.definition.name}
                      </span>
                    )}
                    {!blocked && !claimed && d.recommendedBackend === backend && (
                      <span className="field-hint">Best backend for this card</span>
                    )}
                  </button>
                  );
                })}
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
                {typeof window !== "undefined" && window.revolver && (
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
                )}
              </div>
              <div className="model-scroll">
                {models.filter((m) => m.hasWeights).length === 0 && (
                  <p className="muted">No models on disk. Download from the Models tab.</p>
                )}
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
                <p className="field-hint warn">
                  {runtime === "native"
                    ? "Native runtime is llama.cpp (GGUF) or MLX (macOS safetensors). Switch to Docker for vLLM, or pick a matching model."
                    : "No engines support this model on the selected backend."}
                </p>
              ) : (
                <div className="backend-grid">
                  {compatibleEngines.map((e) => (
                    <button
                      key={e.id}
                      className={`backend-card ${engine === e.id ? "sel" : ""} ${e.id === "mlx" && !mlxAvailable ? "blocked" : ""}`}
                      onClick={() => setEngine(e.id)}
                    >
                      <strong>{e.label}</strong>
                      <span>{e.description}</span>
                      {e.id === "mlx" && !mlxAvailable && (
                        <span className="field-hint warn">{mlxError ?? "mlx-engine runtime not installed"}</span>
                      )}
                      {e.id === "mlx" && mlxAvailable && (
                        <span className="backend-rec">macOS native</span>
                      )}
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
                <dt>Runtime</dt>
                <dd>{engine === "mlx" ? "native revolver_mlx_server" : backend === "metal" ? "native (Metal host-agent)" : runtime === "native" ? "native process" : "Docker container"}</dd>
                <dt>Engine</dt>
                <dd>{activeEngineInfo?.label ?? engine}</dd>
                {backend !== "cpu" && (
                  <>
                    <dt>GPUs</dt>
                    <dd>
                      {gpuDevices
                        .map((i) => {
                          const d = gpu?.devices.find((x) => x.index === i);
                          return d ? `${i} ${d.name}` : String(i);
                        })
                        .join(", ") || "none"}
                      {gpuDevices.length >= 2 && gpuMode === "combined" ? " (combined)" : ""}
                    </dd>
                  </>
                )}
                <dt>Model</dt>
                <dd>{selectedModel.split("/").pop()}</dd>
                <dt>Context</dt>
                <dd>{contextLength.toLocaleString()}</dd>
                <dt>Listen</dt>
                <dd className="mono muted">
                  {runtime === "native" || backend === "metal"
                    ? "Host process on next free port"
                    : "New Docker container on next free port"}
                </dd>
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
              <button
                className="primary"
                disabled={!!busy || !canNext()}
                onClick={() => startServer(false)}
              >
                {busy === "create" ? "Starting…" : "Start server"}
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
            <span className="pill">
              {def.backend === "metal" ? "native" : def.runtime === "native" ? "native" : "docker"}
            </span>
            {def.gpuDevices.length > 0 && (
              <span className="pill">
                GPU {def.gpuDevices.join(",")}
                {def.gpuMode === "combined" ? " combined" : ""}
              </span>
            )}
            <span className="muted mono">{detailStatus.baseUrl}</span>
          </div>
          {detailStatus.running && detailStatus.gatewayUrl && (
            <div className="panel gateway-panel" style={{ marginTop: "1rem" }}>
              <h3 style={{ marginTop: 0 }}>OpenAI gateway (Cline, etc.)</h3>
              <p className="muted small">
                Fixed endpoint — routes by model name. Use this in VS Code instead of the direct
                server port above.
              </p>
              <div className="status-row">
                <span className="mono">{detailStatus.gatewayUrl}/v1</span>
              </div>
              <p className="muted small">
                Model id: <span className="mono">{def.modelId.includes("/") ? def.modelId : def.modelPath.split("/").pop()?.replace(/\.gguf$/i, "") ?? def.modelId}</span>
              </p>
              <ul className="mono small muted" style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                {detailStatus.endpoints.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
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
                  .then(() => {
                    onServerReady?.(def.id);
                    return onRefresh();
                  })
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
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                setConfirmDelete(false);
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
              {confirmDelete ? "Confirm delete" : "Delete"}
            </button>
            {confirmDelete && (
              <button className="ghost" disabled={!!busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            )}
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
            <p className="muted">Create a server to load a model (Docker container or native llama-server).</p>
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
                    <span>{d.backend === "metal" ? "native" : d.runtime === "native" ? "native" : "docker"}</span>
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
            {serverStatus.gatewayUrl && <> · gateway at {serverStatus.gatewayUrl}/v1</>}
          </p>
        </section>
      )}
    </div>
  );
}
