import {
  LINUX_RUNTIME_IDS,
  WIN_RUNTIME_IDS,
  type InferenceBackend,
  type HostRuntimeId,
  type LinuxRuntimeId,
  type RuntimeId,
  type WinRuntimeId,
} from "./types";
import type { GpuDevice, GpuInfo } from "./types";
import { deviceVendor, validateBackendDevices } from "./gpuDevices";

export function isLinuxRuntimeId(id: string): id is LinuxRuntimeId {
  return (LINUX_RUNTIME_IDS as readonly string[]).includes(id);
}

export function isWinRuntimeId(id: string): id is WinRuntimeId {
  return (WIN_RUNTIME_IDS as readonly string[]).includes(id);
}

export function isHostRuntimeId(id: string): id is HostRuntimeId {
  return isLinuxRuntimeId(id) || isWinRuntimeId(id);
}

export function linuxRuntimeBackend(id: LinuxRuntimeId): InferenceBackend {
  if (id === "linux-vulkan") return "vulkan";
  if (id === "linux-cpu") return "cpu";
  return "cuda";
}

export function winRuntimeBackend(id: WinRuntimeId): InferenceBackend {
  if (id === "win-vulkan") return "vulkan";
  if (id === "win-cpu") return "cpu";
  return "cuda";
}

export function hostRuntimeBackend(id: HostRuntimeId): InferenceBackend {
  return isWinRuntimeId(id) ? winRuntimeBackend(id) : linuxRuntimeBackend(id);
}

/** Single CUDA SKU — any NVIDIA compute cap (LMS-style, no Volta/Pascal split). */
export function linuxCudaSkuForCaps(caps: number[]): LinuxRuntimeId | null {
  return caps.length > 0 ? "linux-cuda" : null;
}

function recommendFromGpu(opts: { computeCaps: number[]; gpu: GpuInfo | null }): "cuda" | "vulkan" | "cpu" {
  const vendors = new Set((opts.gpu?.devices ?? []).map((d) => deviceVendor(d)));
  if (vendors.has("nvidia") || opts.computeCaps.length > 0) return "cuda";
  if (vendors.has("amd") || vendors.has("intel")) return "vulkan";
  return "cpu";
}

/** Picker for first-run Install recommended. NVIDIA → CUDA; AMD/Intel → Vulkan; else CPU. */
export function recommendedLinuxRuntimeId(opts: {
  computeCaps: number[];
  gpu: GpuInfo | null;
}): LinuxRuntimeId {
  const kind = recommendFromGpu(opts);
  if (kind === "cuda") return "linux-cuda";
  if (kind === "vulkan") return "linux-vulkan";
  return "linux-cpu";
}

export function recommendedWinRuntimeId(opts: {
  computeCaps: number[];
  gpu: GpuInfo | null;
}): WinRuntimeId {
  const kind = recommendFromGpu(opts);
  if (kind === "cuda") return "win-cuda";
  if (kind === "vulkan") return "win-vulkan";
  return "win-cpu";
}

export function cudaSkuMatchesCaps(id: LinuxRuntimeId | WinRuntimeId, _caps: number[]): boolean {
  return id === "linux-cuda" || id === "win-cuda";
}

function installedSet(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

function anyHostLlamaInstalled(installed: ReadonlySet<string>): boolean {
  return (
    LINUX_RUNTIME_IDS.some((id) => installed.has(id)) ||
    WIN_RUNTIME_IDS.some((id) => installed.has(id))
  );
}

/**
 * Extra native-SKU gate on top of vendor checks.
 * `installed` is host runtime ids currently on disk (linux-* or win-*).
 */
export function nativeSkuBlock(
  backend: InferenceBackend,
  opts: {
    installed: readonly string[];
    computeCaps: number[];
    devices: GpuDevice[];
  },
): string | null {
  const vendorErr = validateBackendDevices(backend, opts.devices);
  if (vendorErr) return vendorErr;

  const installed = installedSet(opts.installed);
  if (backend === "cpu") {
    if (anyHostLlamaInstalled(installed)) return null;
    return "Install a llama.cpp runtime in Config → Manage runtimes.";
  }
  if (backend === "vulkan") {
    if (installed.has("linux-vulkan") || installed.has("win-vulkan")) return null;
    return "Install the Vulkan runtime in Config → Manage runtimes.";
  }
  if (backend === "cuda") {
    if (installed.has("linux-cuda") || installed.has("win-cuda")) return null;
    return "Install the CUDA runtime in Config → Manage runtimes.";
  }
  if (backend === "rocm") {
    return "ROCm is Docker-only. Use Vulkan for native AMD GPUs.";
  }
  return null;
}

export function formatRuntimeIdLabel(id: RuntimeId): string {
  switch (id) {
    case "llamacpp":
      return "llama.cpp (Metal)";
    case "mlx":
      return "MLX";
    case "linux-cuda":
    case "win-cuda":
      return "CUDA llama.cpp";
    case "linux-vulkan":
    case "win-vulkan":
      return "Vulkan llama.cpp";
    case "linux-cpu":
    case "win-cpu":
      return "CPU llama.cpp";
    default:
      return id;
  }
}
