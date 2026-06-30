import { execFileSync } from "child_process";
import os from "os";
import { getGpuInfo } from "../electron/lib/gpu";
import { getMonitorSnapshot } from "../electron/lib/monitor";
import type { GpuInfo, MonitorSnapshot } from "../shared/types";
import { hostAgentCall, metalEnabled } from "./hostAgent";

function getAppleGpuInfo(): GpuInfo {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  let name = "Apple Silicon";
  try {
    name = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim();
  } catch {
    /* default */
  }
  const label = `${name} (Metal)`;
  const usedPercent = total > 0 ? Math.round((used / total) * 1000) / 10 : null;
  return {
    available: true,
    deviceCount: 1,
    totalVramBytes: total,
    totalFreeVramBytes: free,
    devices: [
      {
        index: 0,
        name: label,
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        totalGb: Math.round((total / 1024 ** 3) * 100) / 100,
        freeGb: Math.round((free / 1024 ** 3) * 100) / 100,
        usedPercent,
        gpuUtilPercent: null,
        memUtilPercent: usedPercent,
        temperatureC: null,
        powerW: null,
      },
    ],
  };
}

export async function getGpuInfoAsync(): Promise<GpuInfo> {
  if (metalEnabled()) {
    try {
      const snap = await hostAgentCall<MonitorSnapshot>("monitor");
      if (snap.gpu?.available) return snap.gpu;
    } catch {
      /* host agent unavailable — fall through */
    }
  }
  if (process.platform === "darwin") {
    return getAppleGpuInfo();
  }
  return getGpuInfo();
}

export async function getMonitorSnapshotAsync(): Promise<MonitorSnapshot> {
  if (metalEnabled()) {
    try {
      return await hostAgentCall<MonitorSnapshot>("monitor");
    } catch {
      /* fall through */
    }
  }
  return getMonitorSnapshot();
}
