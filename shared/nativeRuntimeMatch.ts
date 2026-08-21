import { LINUX_RUNTIME_IDS, type InferenceBackend, type LinuxRuntimeId, type RuntimeId } from "./types";
import type { GpuDevice, GpuInfo } from "./types";
import { deviceVendor, validateBackendDevices } from "./gpuDevices";

export function isLinuxRuntimeId(id: string): id is LinuxRuntimeId {
  return (LINUX_RUNTIME_IDS as readonly string[]).includes(id);
}

export function linuxRuntimeBackend(id: LinuxRuntimeId): InferenceBackend {
  if (id === "linux-vulkan") return "vulkan";
  if (id === "linux-cpu") return "cpu";
  return "cuda";
}

/** Single CUDA SKU — any NVIDIA compute cap (LMS-style, no Volta/Pascal split). */
export function linuxCudaSkuForCaps(caps: number[]): LinuxRuntimeId | null {
  return caps.length > 0 ? "linux-cuda" : null;
}

/** Picker for first-run Install recommended. NVIDIA → CUDA; AMD/Intel → Vulkan; else CPU. */
export function recommendedLinuxRuntimeId(opts: {
  computeCaps: number[];
  gpu: GpuInfo | null;
}): LinuxRuntimeId {
  const vendors = new Set((opts.gpu?.devices ?? []).map((d) => deviceVendor(d)));
  if (vendors.has("nvidia") || opts.computeCaps.length > 0) return "linux-cuda";
  if (vendors.has("amd") || vendors.has("intel")) return "linux-vulkan";
  return "linux-cpu";
}

export function cudaSkuMatchesCaps(id: LinuxRuntimeId, _caps: number[]): boolean {
  return id === "linux-cuda";
}

function installedSet(ids: readonly string[]): Set<string> {
  return new Set(ids);
}

function anyLinuxLlamaInstalled(installed: ReadonlySet<string>): boolean {
  return LINUX_RUNTIME_IDS.some((id) => installed.has(id));
}

/**
 * Extra native-SKU gate on top of vendor checks.
 * `installed` is Linux runtime ids currently on disk.
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
    if (anyLinuxLlamaInstalled(installed)) return null;
    return "Install a llama.cpp runtime in Config → Manage runtimes.";
  }
  if (backend === "vulkan") {
    if (installed.has("linux-vulkan")) return null;
    return "Install the Vulkan runtime in Config → Manage runtimes.";
  }
  if (backend === "cuda") {
    if (installed.has("linux-cuda")) return null;
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
      return "CUDA llama.cpp";
    case "linux-vulkan":
      return "Vulkan llama.cpp";
    case "linux-cpu":
      return "CPU llama.cpp";
    default:
      return id;
  }
}
