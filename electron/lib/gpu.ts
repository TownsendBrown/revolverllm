import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import type { GpuInfo } from "./types";

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

function parseNvidiaSmiOutput(out: string): GpuInfo {
  const devices = out
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
      const usedPercent =
        totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null;
      return {
        index: Number(index),
        name,
        totalBytes,
        usedBytes,
        freeBytes,
        totalGb: Math.round((totalBytes / 1024 ** 3) * 100) / 100,
        freeGb: Math.round((freeBytes / 1024 ** 3) * 100) / 100,
        usedPercent,
        gpuUtilPercent: parseNum(gpuUtil ?? ""),
        memUtilPercent: parseNum(memUtil ?? ""),
        temperatureC: parseNum(temperature ?? ""),
        powerW: parseNum(power ?? ""),
      };
    });
  return {
    available: devices.length > 0,
    deviceCount: devices.length,
    totalVramBytes: devices.reduce((s, d) => s + d.totalBytes, 0),
    totalFreeVramBytes: devices.reduce((s, d) => s + d.freeBytes, 0),
    devices,
  };
}

export function getGpuInfo(): GpuInfo {
  try {
    return parseNvidiaSmiOutput(runNvidiaSmi());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      process.env.REVOLVER_DOCKER === "1"
        ? process.env.LLAMA_GPU === "1"
          ? " Ensure NVIDIA Container Toolkit is installed and compose was started with docker-compose.gpu.yml."
          : " Start with npm run docker:up:gpu (docker-compose.gpu.yml overlay) for GPU monitoring."
        : "";
    return {
      available: false,
      error: message + hint,
      deviceCount: 0,
      totalVramBytes: 0,
      totalFreeVramBytes: 0,
      devices: [],
    };
  }
}

export function totalFreeVramBytes(): number | null {
  const info = getGpuInfo();
  if (!info.available) return null;
  return info.totalFreeVramBytes;
}
