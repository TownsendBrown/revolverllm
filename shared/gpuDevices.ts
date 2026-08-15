import type { GpuDevice, GpuInfo, GpuVendor, InferenceBackend } from "./types";

/** PCI device-id (lowercase, no 0x) → AMD marketing name + gfx ISA. */
export const AMD_PCI_META: Record<string, { name: string; arch: string }> = {
  "7310": { name: "Radeon RX 5700", arch: "gfx1010" },
  "731f": { name: "Radeon RX 5700 XT", arch: "gfx1010" },
  "7340": { name: "Radeon RX 5500 XT", arch: "gfx1012" },
  "73a5": { name: "Radeon RX 6950 XT", arch: "gfx1030" },
  "73bf": { name: "Radeon RX 6900 XT", arch: "gfx1030" },
  "73df": { name: "Radeon RX 6700 XT", arch: "gfx1031" },
  "73e3": { name: "Radeon RX 6950 XT", arch: "gfx1030" },
  "73ff": { name: "Radeon RX 6600", arch: "gfx1032" },
  "7448": { name: "Radeon RX 7900 GRE", arch: "gfx1100" },
  "744c": { name: "Radeon RX 7900 XTX", arch: "gfx1100" },
  "747e": { name: "Radeon RX 7800 XT", arch: "gfx1101" },
  "15bf": { name: "Radeon 780M", arch: "gfx1103" },
  "164e": { name: "Radeon 760M", arch: "gfx1103" },
  "7550": { name: "Radeon RX 9070", arch: "gfx1201" },
};

const RDNA1 = new Set(["gfx1010", "gfx1011", "gfx1012"]);

export function normalizePciId(raw: string): string {
  return raw.trim().toLowerCase().replace(/^0x/, "");
}

export function amdPciMeta(deviceId: string): { name: string; arch: string | null } {
  const id = normalizePciId(deviceId);
  const meta = AMD_PCI_META[id];
  if (meta) return meta;
  return { name: `AMD GPU (${id || "unknown"})`, arch: null };
}

export function rocmLikelySupported(arch: string | null | undefined): boolean {
  if (!arch) return false;
  if (RDNA1.has(arch)) return false;
  return /^gfx(9|10|11|12)/.test(arch);
}

export function recommendedBackendForVendor(vendor: GpuVendor): InferenceBackend {
  if (vendor === "nvidia") return "cuda";
  if (vendor === "apple") return "metal";
  return "vulkan";
}

export function vendorLabel(vendor: GpuVendor): string {
  switch (vendor) {
    case "nvidia":
      return "NVIDIA";
    case "amd":
      return "AMD";
    case "intel":
      return "Intel";
    case "apple":
      return "Apple";
  }
}

export function parseDrmUevent(text: string): {
  driver: string | null;
  vendorId: string | null;
  deviceId: string | null;
  slot: string | null;
} {
  let driver: string | null = null;
  let vendorId: string | null = null;
  let deviceId: string | null = null;
  let slot: string | null = null;
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "DRIVER") driver = value;
    if (key === "PCI_SLOT_NAME") slot = value;
    if (key === "PCI_ID") {
      const [v, d] = value.split(":");
      vendorId = v ? normalizePciId(v) : null;
      deviceId = d ? normalizePciId(d) : null;
    }
  }
  return { driver, vendorId, deviceId, slot };
}

export interface VulkanDeviceSummary {
  vulkanIndex: number;
  vendorId: string;
  deviceId: string;
  name: string;
  driver: string | null;
  cpu: boolean;
}

/** Parse `vulkaninfo --summary` Devices: block. */
export function parseVulkanSummary(text: string): VulkanDeviceSummary[] {
  const devices: VulkanDeviceSummary[] = [];
  const gpuBlocks = text.split(/GPU(\d+):/g);
  // split yields [preamble, index, body, index, body, ...]
  for (let i = 1; i < gpuBlocks.length; i += 2) {
    const vulkanIndex = Number(gpuBlocks[i]);
    const body = gpuBlocks[i + 1] ?? "";
    const vendorId = normalizePciId(matchField(body, "vendorID") ?? "");
    const deviceId = normalizePciId(matchField(body, "deviceID") ?? "");
    const name = matchField(body, "deviceName") ?? `Vulkan GPU ${vulkanIndex}`;
    const driver = matchField(body, "driverName");
    const type = matchField(body, "deviceType") ?? "";
    const cpu = type.includes("CPU") || /llvmpipe|lavapipe/i.test(name);
    if (!Number.isFinite(vulkanIndex)) continue;
    devices.push({ vulkanIndex, vendorId, deviceId, name, driver, cpu });
  }
  return devices.filter((d) => !d.cpu);
}

function matchField(body: string, key: string): string | null {
  const re = new RegExp(`${key}\\s*=\\s*(.+)`, "i");
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

export function applyVulkanIndices(
  devices: GpuDevice[],
  vulkan: VulkanDeviceSummary[],
): GpuDevice[] {
  return devices.map((d) => {
    const vendorId =
      d.vendor === "nvidia" ? "10de" : d.vendor === "amd" ? "1002" : d.vendor === "intel" ? "8086" : null;
    if (!vendorId) return { ...d, vulkanIndex: d.vulkanIndex ?? null };
    const sameVendor = vulkan.filter((v) => v.vendorId === vendorId);
    const ordinal = d.vendor === "nvidia" ? d.nvidiaIndex : d.vendor === "amd" ? d.amdIndex : 0;
    const pick = ordinal != null ? sameVendor[ordinal] : sameVendor[0];
    if (!pick) {
      return { ...d, vulkanIndex: d.vulkanIndex ?? d.amdIndex ?? null };
    }
    return {
      ...d,
      vulkanIndex: pick.vulkanIndex,
      name: pick.name || d.name,
    };
  });
}

export function deviceVendor(d: GpuDevice): GpuVendor {
  return d.vendor ?? "nvidia";
}

export function backendLabel(backend: InferenceBackend): string {
  switch (backend) {
    case "cuda":
      return "CUDA";
    case "rocm":
      return "ROCm";
    case "vulkan":
      return "Vulkan";
    case "metal":
      return "Metal";
    case "cpu":
      return "CPU";
  }
}

/** True when this physical GPU can actually run the inference backend. */
export function deviceUsableForBackend(d: GpuDevice, backend: InferenceBackend): boolean {
  const v = deviceVendor(d);
  switch (backend) {
    case "cuda":
      return v === "nvidia";
    case "rocm":
      return v === "amd" && rocmLikelySupported(d.arch);
    case "vulkan":
      return v === "amd" || v === "intel" || v === "nvidia";
    case "metal":
      return v === "apple";
    case "cpu":
      return false;
  }
}

export function devicesForBackend(
  devices: GpuDevice[],
  backend: InferenceBackend,
): GpuDevice[] {
  if (backend === "cpu") return [];
  return devices.filter((d) => deviceUsableForBackend(d, backend));
}

export function incompatibleDeviceReason(d: GpuDevice, backend: InferenceBackend): string | null {
  if (deviceUsableForBackend(d, backend)) return null;
  const rec = backendLabel(d.recommendedBackend);
  if (backend === "cuda") {
    return `${d.name} is ${vendorLabel(deviceVendor(d))}, not NVIDIA — CUDA cannot use it. Use ${rec}.`;
  }
  if (backend === "rocm") {
    if (deviceVendor(d) === "amd") {
      return `${d.name} (${d.arch ?? "RDNA1"}) is not supported by current ROCm images — use Vulkan.`;
    }
    return `${d.name} is not an AMD GPU — ROCm cannot use it. Use ${rec}.`;
  }
  if (backend === "vulkan") {
    return `${d.name} cannot use Vulkan. Use ${rec}.`;
  }
  if (backend === "metal") {
    return `${d.name} is not Apple Silicon — Metal cannot use it.`;
  }
  return `${d.name} cannot use ${backendLabel(backend)}.`;
}

function matchSelectedDevices(
  devices: GpuDevice[],
  selected: number[],
  backend: InferenceBackend,
): { unique: GpuDevice[]; runtime: GpuDevice[] } {
  const unique = devices.filter((d) => selected.includes(d.index));
  const runtime = devices.filter((d) => {
    const r = runtimeIndex(d, backend);
    return r != null && selected.includes(r);
  });
  return { unique, runtime };
}

/**
 * Hard error when the backend cannot run on the detected / selected GPUs.
 * `selected` may be UI unique indices or backend-native runtime indices.
 */
export function validateBackendDevices(
  backend: InferenceBackend,
  devices: GpuDevice[],
  selected: number[] = [],
): string | null {
  if (backend === "cpu") return null;
  const usable = devicesForBackend(devices, backend);
  if (usable.length === 0) {
    if (backend === "cuda") {
      const amd = devices.find((d) => deviceVendor(d) === "amd");
      if (amd) {
        return `CUDA requires an NVIDIA GPU. ${amd.name} supports ${backendLabel(amd.recommendedBackend)} only.`;
      }
      return "CUDA requires an NVIDIA GPU (nvidia-smi).";
    }
    if (backend === "rocm") {
      const amd = devices.find((d) => deviceVendor(d) === "amd");
      if (amd) return incompatibleDeviceReason(amd, "rocm");
      return "ROCm requires an AMD GPU with gfx1030+ (RDNA2 or newer).";
    }
    if (backend === "vulkan") return "Vulkan requires an AMD, Intel, or NVIDIA GPU.";
    if (backend === "metal") return "Metal requires Apple Silicon.";
  }
  if (!selected.length) return null;
  const { unique, runtime } = matchSelectedDevices(devices, selected, backend);
  const uniqueGood = unique.filter((d) => deviceUsableForBackend(d, backend));
  const uniqueBad = unique.filter((d) => !deviceUsableForBackend(d, backend));
  const runtimeGood = runtime.filter((d) => deviceUsableForBackend(d, backend));
  const runtimeBad = runtime.filter((d) => !deviceUsableForBackend(d, backend));
  if (runtimeBad.length && !runtimeGood.length && !uniqueGood.length) {
    return incompatibleDeviceReason(runtimeBad[0], backend);
  }
  if (uniqueBad.length && !uniqueGood.length && !runtimeGood.length) {
    return incompatibleDeviceReason(uniqueBad[0], backend);
  }
  if (uniqueGood.length || runtimeGood.length) return null;
  return `Selected GPU index ${selected.join(",")} is not valid for ${backendLabel(backend)}.`;
}

export function runtimeIndex(d: GpuDevice, backend: InferenceBackend): number | null {
  switch (backend) {
    case "cuda":
      return d.nvidiaIndex ?? (deviceVendor(d) === "nvidia" ? d.index : null);
    case "rocm":
      return d.amdIndex ?? (deviceVendor(d) === "amd" ? 0 : null);
    case "vulkan":
      return d.vulkanIndex ?? d.amdIndex ?? (deviceVendor(d) === "amd" || deviceVendor(d) === "intel" ? 0 : null);
    default:
      return null;
  }
}

/** Map UI unique indices → backend-native device ids stored on the server def. */
export function runtimeIndicesFromSelection(
  devices: GpuDevice[],
  selectedUnique: number[],
  backend: InferenceBackend,
): number[] {
  const requested = selectedUnique.length
    ? devices.filter((d) => selectedUnique.includes(d.index))
    : devicesForBackend(devices, backend).slice(0, 1);
  return requested
    .filter((d) => deviceUsableForBackend(d, backend))
    .map((d) => runtimeIndex(d, backend))
    .filter((n): n is number => n != null);
}

export function recommendedWizardBackend(
  macMetal: boolean,
  dockerGpu: boolean,
  gpu: GpuInfo | null,
): InferenceBackend {
  if (macMetal && !dockerGpu) return "metal";
  if (!gpu?.available || gpu.devices.length === 0) return "cpu";
  const vendors = new Set(gpu.devices.map((d) => deviceVendor(d)));
  if (vendors.has("nvidia")) return "cuda";
  if (vendors.has("amd") || vendors.has("intel")) return "vulkan";
  if (vendors.has("apple")) return "metal";
  return "cpu";
}

export function backendGpuHint(
  backend: InferenceBackend,
  devices: GpuDevice[],
): string | null {
  if (backend === "cpu") return null;
  const blocked = validateBackendDevices(backend, devices);
  if (blocked) return blocked;
  const excluded = devices.filter((d) => !deviceUsableForBackend(d, backend));
  if (excluded.length) {
    return excluded
      .map((d) => incompatibleDeviceReason(d, backend))
      .filter((s): s is string => !!s)
      .join(" ");
  }
  return null;
}

/**
 * Env for the llama.cpp Vulkan container.
 * Pinning RADV/ANV ICDs remaps physical devices to 0..n-1 inside the image
 * (host vulkaninfo order includes NVIDIA proprietary, the Mesa image does not).
 */
export function vulkanDriverEnv(
  devices: GpuDevice[],
  vulkanIndices: number[],
): Record<string, string> {
  const env: Record<string, string> = { VK_LOADER_DRIVERS_DISABLE: "lvp" };
  const selected = devices.filter(
    (d) => d.vulkanIndex != null && vulkanIndices.includes(d.vulkanIndex),
  );
  const pool = selected.length
    ? selected
    : vulkanIndices.length
      ? []
      : devices.filter((d) => d.vendor === "amd" || d.vendor === "intel");
  const vendors = new Set(pool.map((d) => d.vendor));
  const pinAmd = vendors.has("amd") && !vendors.has("nvidia") && !vendors.has("intel");
  const pinIntel = vendors.has("intel") && !vendors.has("amd") && !vendors.has("nvidia");
  if (pinAmd) {
    env.VK_ICD_FILENAMES =
      "/usr/share/vulkan/icd.d/radeon_icd.json:/usr/share/vulkan/icd.d/radeon_icd.x86_64.json";
  }
  if (pinIntel) {
    env.VK_ICD_FILENAMES =
      "/usr/share/vulkan/icd.d/intel_icd.json:/usr/share/vulkan/icd.d/intel_icd.x86_64.json";
  }
  if (pinAmd || pinIntel) {
    const n = Math.max(1, selected.length || pool.length);
    env.GGML_VK_VISIBLE_DEVICES = Array.from({ length: n }, (_, i) => String(i)).join(",");
  } else if (vulkanIndices.length) {
    env.GGML_VK_VISIBLE_DEVICES = vulkanIndices.join(",");
  }
  return env;
}

export function assignUniqueIndices(devices: Omit<GpuDevice, "index">[]): GpuDevice[] {
  return devices.map((d, index) => ({ ...d, index }));
}
