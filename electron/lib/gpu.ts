import { execFileSync, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  amdPciMeta,
  applyVulkanIndices,
  assignUniqueIndices,
  parseDrmUevent,
  parseVulkanSummary,
  recommendedBackendForVendor,
} from "../../shared/gpuDevices";
import type { GpuDevice, GpuInfo } from "./types";

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw",
  "--format=csv,noheader,nounits",
];

const NVIDIA_LD_LIBRARY_PATH = [
  process.env.LD_LIBRARY_PATH,
  "/usr/local/nvidia/lib",
  "/usr/local/nvidia/lib64",
  "/usr/lib/x86_64-linux-gnu",
]
  .filter(Boolean)
  .join(":");

function parseNum(raw: string): number | null {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 100) / 100;
}

function usedPercent(used: number, total: number): number | null {
  return total > 0 ? Math.round((used / total) * 1000) / 10 : null;
}

function emptyGpu(error: string): GpuInfo {
  return {
    available: false,
    error,
    deviceCount: 0,
    totalVramBytes: 0,
    totalFreeVramBytes: 0,
    devices: [],
  };
}

function summarize(devices: GpuDevice[]): GpuInfo {
  return {
    available: devices.length > 0,
    deviceCount: devices.length,
    totalVramBytes: devices.reduce((s, d) => s + d.totalBytes, 0),
    totalFreeVramBytes: devices.reduce((s, d) => s + d.freeBytes, 0),
    devices,
  };
}

function sysfsRoot(): string {
  return (process.env.REVOLVER_SYSFS ?? "/sys").replace(/\/+$/, "");
}

function resolveNvidiaSmi(): string {
  const envPath = process.env.NVIDIA_SMI_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  for (const candidate of ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"]) {
    if (existsSync(candidate)) return candidate;
  }

  const which = spawnSync("which", ["nvidia-smi"], { encoding: "utf8" });
  if (which.status === 0) {
    const found = which.stdout.trim();
    if (found) return found;
  }

  throw new Error(
    "nvidia-smi not found — install NVIDIA drivers or set NVIDIA_SMI_PATH",
  );
}

function runNvidiaSmiBinary(bin: string): string {
  return execFileSync(bin, NVIDIA_SMI_ARGS, {
    encoding: "utf8",
    env: {
      ...process.env,
      LD_LIBRARY_PATH: NVIDIA_LD_LIBRARY_PATH,
    },
  });
}

function runNvidiaSmiDirect(): string {
  return runNvidiaSmiBinary(resolveNvidiaSmi());
}

/** Query GPU stats via the llama-server container (has GPU in docker-compose.gpu.yml). */
function runNvidiaSmiViaLlamaContainer(): string {
  const container = process.env.LLAMA_CONTAINER ?? "revolver-llama-server";
  return execFileSync(
    "docker",
    ["exec", container, "nvidia-smi", ...NVIDIA_SMI_ARGS],
    {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
}

function runNvidiaSmi(): string {
  try {
    return runNvidiaSmiDirect();
  } catch (directErr) {
    if (process.env.REVOLVER_DOCKER !== "1" || process.env.LLAMA_GPU !== "1") {
      throw directErr;
    }
    try {
      return runNvidiaSmiViaLlamaContainer();
    } catch {
      throw directErr;
    }
  }
}

function parseNvidiaSmiOutput(out: string): Omit<GpuDevice, "index">[] {
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        index,
        name,
        total,
        used,
        free,
        gpuUtil,
        memUtil,
        temperature,
        power,
      ] = line.split(",").map((s) => s.trim());
      const totalBytes = Math.floor(Number(total) * 1024 * 1024);
      const usedBytes = Math.floor(Number(used) * 1024 * 1024);
      const freeBytes = Math.floor(Number(free) * 1024 * 1024);
      const nvidiaIndex = Number(index);
      return {
        name,
        vendor: "nvidia" as const,
        recommendedBackend: recommendedBackendForVendor("nvidia"),
        arch: null,
        nvidiaIndex: Number.isFinite(nvidiaIndex) ? nvidiaIndex : 0,
        amdIndex: null,
        vulkanIndex: null,
        totalBytes,
        usedBytes,
        freeBytes,
        totalGb: toGb(totalBytes),
        freeGb: toGb(freeBytes),
        usedPercent: usedPercent(usedBytes, totalBytes),
        gpuUtilPercent: parseNum(gpuUtil ?? ""),
        memUtilPercent: parseNum(memUtil ?? ""),
        temperatureC: parseNum(temperature ?? ""),
        powerW: parseNum(power ?? ""),
      };
    });
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readUint(path: string): number | null {
  const raw = readTrim(path);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readHwmon(cardDeviceDir: string): { temperatureC: number | null; powerW: number | null } {
  const hwmonRoot = join(cardDeviceDir, "hwmon");
  if (!existsSync(hwmonRoot)) return { temperatureC: null, powerW: null };
  let temperatureC: number | null = null;
  let powerW: number | null = null;
  try {
    for (const name of readdirSync(hwmonRoot)) {
      const dir = join(hwmonRoot, name);
      const temp = readUint(join(dir, "temp1_input"));
      if (temp != null) temperatureC = Math.round(temp / 1000);
      const power = readUint(join(dir, "power1_average")) ?? readUint(join(dir, "power1_input"));
      if (power != null) powerW = Math.round(power / 1_000_000);
    }
  } catch {
    /* missing hwmon */
  }
  return { temperatureC, powerW };
}

function lspciName(slot: string | null): string | null {
  if (!slot) return null;
  const short = slot.replace(/^0000:/, "");
  try {
    const out = execFileSync("lspci", ["-s", short, "-nn"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    // "04:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX 5700 XT] [1002:731f] (rev c1)"
    const m = out.match(/]:\s*(.+?)\s*\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\]/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function scanAmdGpusFromSysfs(root = sysfsRoot()): Omit<GpuDevice, "index">[] {
  const drmDir = join(root, "class/drm");
  if (!existsSync(drmDir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(drmDir).filter((n) => /^card\d+$/.test(n)).sort();
  } catch {
    return [];
  }

  const devices: Omit<GpuDevice, "index">[] = [];
  let amdIndex = 0;
  for (const card of names) {
    const deviceDir = join(drmDir, card, "device");
    const uevent = readTrim(join(deviceDir, "uevent")) ?? "";
    const parsed = parseDrmUevent(uevent);
    const vendorFile = readTrim(join(deviceDir, "vendor"));
    const vendorId = parsed.vendorId ?? (vendorFile ? vendorFile.replace(/^0x/i, "").toLowerCase() : null);
    if (vendorId !== "1002") continue;
    if (parsed.driver && parsed.driver !== "amdgpu") continue;

    const deviceFile = readTrim(join(deviceDir, "device"));
    const deviceId =
      parsed.deviceId ?? (deviceFile ? deviceFile.replace(/^0x/i, "").toLowerCase() : "");
    const meta = amdPciMeta(deviceId);
    const product = readTrim(join(deviceDir, "product_name"));
    const pci = lspciName(parsed.slot);
    const name = product || meta.name || pci || `AMD GPU (${deviceId || "unknown"})`;

    const totalBytes = readUint(join(deviceDir, "mem_info_vram_total")) ?? 0;
    const usedBytes = readUint(join(deviceDir, "mem_info_vram_used")) ?? 0;
    const freeBytes = Math.max(0, totalBytes - usedBytes);
    const busy = readUint(join(deviceDir, "gpu_busy_percent"));
    const hwmon = readHwmon(deviceDir);

    devices.push({
      name,
      vendor: "amd",
      recommendedBackend: recommendedBackendForVendor("amd"),
      arch: meta.arch,
      nvidiaIndex: null,
      amdIndex,
      vulkanIndex: amdIndex,
      totalBytes,
      usedBytes,
      freeBytes,
      totalGb: toGb(totalBytes),
      freeGb: toGb(freeBytes),
      usedPercent: usedPercent(usedBytes, totalBytes),
      gpuUtilPercent: busy,
      memUtilPercent: usedPercent(usedBytes, totalBytes),
      temperatureC: hwmon.temperatureC,
      powerW: hwmon.powerW,
    });
    amdIndex += 1;
  }
  return devices;
}

function runVulkanInfo(): string | null {
  try {
    const result = spawnSync("vulkaninfo", ["--summary"], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.status === 0 && result.stdout) return result.stdout;
  } catch {
    /* vulkaninfo optional */
  }
  return null;
}

function collectHostGpus(): { devices: GpuDevice[]; errors: string[] } {
  const errors: string[] = [];
  let nvidia: Omit<GpuDevice, "index">[] = [];
  try {
    nvidia = parseNvidiaSmiOutput(runNvidiaSmi());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      process.env.REVOLVER_DOCKER === "1"
        ? process.env.LLAMA_GPU === "1"
          ? " Ensure NVIDIA Container Toolkit is installed and compose was started with docker-compose.gpu.yml."
          : " NVIDIA monitoring needs docker-compose.gpu.yml (nvidia-smi). AMD GPUs use sysfs and do not need that overlay."
        : "";
    errors.push(message + hint);
  }

  const amd = scanAmdGpusFromSysfs();
  let devices = assignUniqueIndices([...nvidia, ...amd]);

  const vulkanOut = runVulkanInfo();
  if (vulkanOut) {
    devices = applyVulkanIndices(devices, parseVulkanSummary(vulkanOut));
  }

  return { devices, errors };
}

export function getGpuInfo(): GpuInfo {
  const { devices, errors } = collectHostGpus();
  if (devices.length === 0) {
    return emptyGpu(
      errors.join(" ") ||
        "No GPU detected — NVIDIA needs nvidia-smi; AMD needs amdgpu (/dev/dri + /sys/class/drm).",
    );
  }
  return summarize(devices);
}

export function totalFreeVramBytes(): number | null {
  const info = getGpuInfo();
  if (!info.available) return null;
  return info.totalFreeVramBytes;
}
