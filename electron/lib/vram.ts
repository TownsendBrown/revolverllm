import { LOAD_DEFAULTS } from "./localMeta";
import type { GuardrailMode, GuardrailResult, VramEstimate } from "./types";

/**
 * modelLoadingGuardrails — blocks loads that risk OOM.
 * Modes reserve a headroom fraction of available VRAM; custom keeps a fixed
 * number of bytes free. `off` never blocks.
 */
const GUARDRAIL_HEADROOM: Record<Exclude<GuardrailMode, "off" | "custom">, number> = {
  low: 0.0,
  medium: 0.1,
  high: 0.2,
};

/** Reserve held back for OS/display per device. */
const SYSTEM_RESERVE_BYTES = 1024 ** 3;

export function evaluateGuardrails(
  estimate: VramEstimate,
  guardrails: { mode: string; customThresholdBytes: number; alwaysAllowLoadAnyway?: boolean },
): GuardrailResult {
  const mode = (
    ["off", "low", "medium", "high", "custom"].includes(guardrails.mode) ? guardrails.mode : "high"
  ) as GuardrailMode;

  const deviceCount = estimate.gpuDeviceCount ?? 1;
  const multiGpu = deviceCount > 1 && estimate.peakGpuBytes != null;
  // Guardrails compare against GPU peak when offloading; otherwise total load size.
  const usage =
    estimate.peakGpuBytes != null && estimate.weightsBytes > estimate.peakGpuBytes
      ? estimate.peakGpuBytes
      : estimate.totalBytes;

  // Revolver runs one llama-server container per server definition, so multiple
  // models coexist on different GPUs — there is no auto-evict. The budget is the
  // live FREE VRAM on the *selected* device(s) (already reflects other loaded
  // models), not total device capacity. Fall back to capacity only when free is
  // unknown (e.g. nvidia-smi unavailable).
  let budget: number | null;
  if (multiGpu) {
    budget = estimate.minGpuFreeBytes ?? estimate.minGpuCapacityBytes ?? null;
  } else {
    budget = estimate.availableVramBytes ?? estimate.capacityVramBytes ?? null;
  }
  const available = budget != null ? Math.max(0, budget - SYSTEM_RESERVE_BYTES) : null;

  if (mode === "off" || guardrails.alwaysAllowLoadAnyway) {
    return { passes: true, mode, reason: "guardrails off", requiredFreeBytes: null, availableBytes: available };
  }
  if (available == null) {
    return { passes: true, mode, reason: "VRAM unknown", requiredFreeBytes: null, availableBytes: null };
  }

  let requiredFree: number;
  if (mode === "custom") {
    requiredFree = usage + guardrails.customThresholdBytes;
  } else {
    requiredFree = Math.ceil(usage / (1 - GUARDRAIL_HEADROOM[mode]));
  }

  const passes = requiredFree <= available;
  const usageGb = (usage / 1024 ** 3).toFixed(1);
  const availGb = (available / 1024 ** 3).toFixed(1);
  const per = multiGpu ? " per GPU" : "";
  return {
    passes,
    mode,
    reason: passes
      ? `fits (${usageGb} GB ≤ ${availGb} GB usable${per})`
      : `${mode} guardrail: needs ${(requiredFree / 1024 ** 3).toFixed(1)} GB but ${availGb} GB usable${per}`,
    requiredFreeBytes: requiredFree,
    availableBytes: available,
  };
}

const KV_DTYPE_BYTES: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1,
  q4_0: 0.5,
  q4_k: 0.5,
  q4_k_m: 0.5,
  auto: 2,
};

/** llama-server defaults */
const DEFAULT_N_PARALLEL = 4;
const KV_UNIFIED = true;

function resolveKvHeads(meta: Record<string, unknown>): number {
  const kv = meta.num_key_value_heads ?? meta.numKeyValueHeads;
  if (kv == null) return Number(meta.num_attention_heads ?? meta.numAttentionHeads ?? 1);
  if (Array.isArray(kv)) return Math.max(...kv.map(Number));
  return Number(kv);
}

function resolveLayers(meta: Record<string, unknown>): number {
  const n = Number(meta.num_layers ?? meta.numLayers ?? meta.block_count ?? 0);
  return n > 0 ? n : 1;
}

function resolveSlidingWindow(meta: Record<string, unknown>): number | null {
  const sw = meta.sliding_window ?? meta.slidingWindow;
  if (sw == null) return null;
  const n = Number(sw);
  return n > 0 ? n : null;
}

/**
 * Whether layer `i` uses sliding-window (local) attention.
 * - Explicit per-layer pattern (gemma3/4): `true` = sliding, `false` = global.
 * - No pattern but a window is set (e.g. gpt-oss): assume an alternating
 *   sliding/global interleave so the cache still grows with context length.
 * - No window: every layer is full-context.
 */
function layerIsSliding(
  i: number,
  slidingWindow: number | null,
  pattern: boolean[] | null,
): boolean {
  if (pattern && pattern.length > 0) return pattern[i % pattern.length] === true;
  if (slidingWindow != null && slidingWindow > 0) return i % 2 === 0;
  return false;
}

/** Informational: the largest per-layer KV context (full-context layers drive growth). */
export function effectiveKvContext(contextLength: number, slidingWindow: number | null): number {
  if (slidingWindow != null && slidingWindow > 0) {
    return Math.min(contextLength, slidingWindow);
  }
  return contextLength;
}

export function estimateKvCacheBytes(
  contextLength: number,
  numLayers: number,
  embeddingLength: number,
  numAttentionHeads: number,
  numKeyValueHeads: number,
  kvCacheDtype = "f16",
  opts?: {
    slidingWindow?: number | null;
    keyLength?: number | null;
    valueLength?: number | null;
    nParallel?: number;
    kvUnified?: boolean;
    slidingWindowPattern?: boolean[] | null;
    perLayerKvHeads?: number[] | null;
    swaKeyLength?: number | null;
    swaValueLength?: number | null;
  },
): number {
  if (contextLength <= 0 || numLayers <= 0) return 0;

  const dtypeBytes = KV_DTYPE_BYTES[kvCacheDtype.toLowerCase()] ?? 2;
  const slidingWindow = opts?.slidingWindow ?? null;
  const pattern = opts?.slidingWindowPattern ?? null;
  const perLayerKv = opts?.perLayerKvHeads ?? null;

  const headDim = embeddingLength / Math.max(numAttentionHeads, 1);
  const keyLenFull = opts?.keyLength && opts.keyLength > 0 ? opts.keyLength : headDim;
  const valLenFull = opts?.valueLength && opts.valueLength > 0 ? opts.valueLength : headDim;
  const keyLenSwa = opts?.swaKeyLength && opts.swaKeyLength > 0 ? opts.swaKeyLength : keyLenFull;
  const valLenSwa = opts?.swaValueLength && opts.swaValueLength > 0 ? opts.swaValueLength : valLenFull;

  // Sum KV per layer: only sliding layers are capped at the window, while global
  // layers attend to the full context — so total KV still scales with context.
  let total = 0;
  for (let i = 0; i < numLayers; i++) {
    const sliding = layerIsSliding(i, slidingWindow, pattern);
    const layerCtx = sliding && slidingWindow ? Math.min(contextLength, slidingWindow) : contextLength;
    const kvHeads = perLayerKv && perLayerKv.length > 0
      ? perLayerKv[i % perLayerKv.length] || numKeyValueHeads
      : numKeyValueHeads;
    const keyLen = sliding ? keyLenSwa : keyLenFull;
    const valLen = sliding ? valLenSwa : valLenFull;
    total += layerCtx * kvHeads * (keyLen + valLen) * dtypeBytes;
  }

  const slots = opts?.kvUnified === false ? (opts?.nParallel ?? DEFAULT_N_PARALLEL) : 1;
  return Math.floor(total * slots);
}

export function estimateWeightsOnGpu(
  modelFileBytes: number,
  numLayers: number,
  nGpuLayers: number,
): number {
  // 0 means CPU-only offload settings; -1 (or >= numLayers) means all layers on GPU.
  if (nGpuLayers === 0) return 0;
  if (nGpuLayers < 0 || nGpuLayers >= numLayers) return modelFileBytes;
  return Math.floor(modelFileBytes * (nGpuLayers / numLayers));
}

/** Map UI/runtime values to llama.cpp `--n-gpu-layers` (0 = CPU, -1 = all). */
export function effectiveGpuLayers(
  backend: string | null | undefined,
  nGpuLayers: number | null | undefined,
): number {
  if (backend === "cpu") return 0;
  const n = nGpuLayers ?? -1;
  // Saved runtime config sometimes has 0 from an old CPU session — treat as "all" for GPU backends.
  if (n === 0) return -1;
  return n;
}


export function estimateVram(opts: {
  modelFileBytes: number;
  ggufMeta?: Record<string, unknown>;
  contextLength: number;
  nGpuLayers?: number;
  kvCacheDtype?: string;
  visionAdapterBytes?: number;
  minMemoryHintBytes?: number | null;
  availableVramBytes?: number | null;
  minGpuFreeBytes?: number | null;
  capacityVramBytes?: number | null;
  minGpuCapacityBytes?: number | null;
  gpuDeviceCount?: number | null;
  loadDefaults?: Partial<typeof LOAD_DEFAULTS>;
  /** When set, GPU peak/guardrails use this instead of inferring from nGpuLayers alone. */
  backend?: string | null;
}): VramEstimate {
  const meta = opts.ggufMeta ?? {};
  const gpuLayers = effectiveGpuLayers(opts.backend, opts.nGpuLayers ?? -1);
  const numLayers = resolveLayers(meta);
  const embeddingLength = Number(meta.embedding_length ?? meta.embeddingLength ?? 4096);
  const numAttentionHeads = Number(meta.num_attention_heads ?? meta.numAttentionHeads ?? 32);
  const numKvHeads = resolveKvHeads(meta);
  const slidingWindow = resolveSlidingWindow(meta);
  const keyLength = Number(meta.key_length ?? meta.keyLength ?? 0) || null;
  const valueLength = Number(meta.value_length ?? meta.valueLength ?? 0) || null;
  const swaKeyLength = Number(meta.key_length_swa ?? meta.keyLengthSwa ?? 0) || null;
  const swaValueLength = Number(meta.value_length_swa ?? meta.valueLengthSwa ?? 0) || null;
  const slidingWindowPattern =
    (meta.sliding_window_pattern as boolean[] | null) ??
    (meta.slidingWindowPattern as boolean[] | null) ??
    null;
  const perLayerKvHeads =
    (meta.head_count_kv_per_layer as number[] | null) ??
    (meta.headCountKvPerLayer as number[] | null) ??
    null;
  const hasGlobalLayer =
    slidingWindow == null ||
    (slidingWindowPattern?.some((s) => s === false) ?? true);
  const kvCtx = hasGlobalLayer ? opts.contextLength : effectiveKvContext(opts.contextLength, slidingWindow);
  const load = { ...LOAD_DEFAULTS, ...opts.loadDefaults };

  // Total memory to load (always the full model file + KV + vision) — what the UI should show.
  const modelWeightsBytes = opts.modelFileBytes;
  const weightsForHint = Math.max(modelWeightsBytes, opts.minMemoryHintBytes ?? 0);

  const gpuWeightsBytes = estimateWeightsOnGpu(weightsForHint, numLayers, gpuLayers);

  const kv = estimateKvCacheBytes(
    opts.contextLength,
    numLayers,
    embeddingLength,
    numAttentionHeads,
    numKvHeads,
    opts.kvCacheDtype ?? "f16",
    {
      slidingWindow,
      keyLength,
      valueLength,
      nParallel: load.maxParallelPredictions,
      kvUnified: load.useUnifiedKvCache,
      slidingWindowPattern,
      perLayerKvHeads,
      swaKeyLength,
      swaValueLength,
    },
  );
  const visionBytes = opts.visionAdapterBytes ?? 0;

  // Footprint shown in the UI (model + context at chosen ctx, independent of GPU split).
  const loadSubtotal = weightsForHint + kv + visionBytes;
  const loadOverhead = Math.floor(loadSubtotal * 0.08);
  const total = loadSubtotal + loadOverhead;

  // GPU VRAM peak for guardrails (respects layer offload setting).
  const gpuVision = gpuLayers !== 0 ? visionBytes : 0;
  const deviceCount = Math.max(1, opts.gpuDeviceCount ?? 1);
  const weightsPerGpu = Math.ceil(gpuWeightsBytes / deviceCount);
  const contextPerGpu = load.offloadKVCacheToGpu && gpuLayers !== 0 ? kv : 0;
  const gpuOverhead = Math.floor((gpuWeightsBytes + contextPerGpu + gpuVision) * 0.08);
  const peakGpuBytes =
    weightsPerGpu + contextPerGpu + Math.ceil((gpuVision + gpuOverhead) / deviceCount);

  const totalFree = opts.availableVramBytes ?? null;
  const minGpuFree = opts.minGpuFreeBytes ?? null;

  let fitsInVram: boolean | null = null;
  if (deviceCount > 1 && minGpuFree != null) {
    fitsInVram = peakGpuBytes <= minGpuFree;
  } else if (totalFree != null) {
    fitsInVram = (gpuLayers !== 0 ? peakGpuBytes : total) <= totalFree;
  }

  const hasArch = numLayers > 0 && embeddingLength > 0 && numKvHeads > 0;
  const confidence: "high" | "low" =
    hasArch && (opts.ggufMeta?.source === "metadata-cache" || slidingWindow != null)
      ? "high"
      : hasArch
        ? "high"
        : "low";

  return {
    totalBytes: total,
    totalGb: Math.round((total / 1024 ** 3) * 100) / 100,
    modelVramBytes: weightsForHint + Math.ceil(loadOverhead * 0.6),
    contextVramBytes: kv + Math.ceil(loadOverhead * 0.4),
    weightsBytes: weightsForHint,
    kvCacheBytes: kv,
    visionAdapterBytes: visionBytes,
    overheadBytes: loadOverhead,
    fitsInVram,
    confidence,
    availableVramBytes: totalFree,
    availableVramGb: totalFree != null ? Math.round((totalFree / 1024 ** 3) * 100) / 100 : null,
    minGpuFreeBytes: minGpuFree,
    capacityVramBytes: opts.capacityVramBytes ?? null,
    minGpuCapacityBytes: opts.minGpuCapacityBytes ?? null,
    gpuDeviceCount: opts.gpuDeviceCount ?? null,
    peakGpuBytes,
    peakGpuGb: Math.round((peakGpuBytes / 1024 ** 3) * 100) / 100,
    effectiveKvContext: kvCtx,
    slidingWindow,
    metadataSource: String(opts.ggufMeta?.source ?? "unknown"),
    breakdown: { weights: weightsForHint, kvCache: kv, visionAdapter: visionBytes, overhead: loadOverhead },
  };
}
