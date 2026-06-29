import { getGpuInfo } from "./gpu";
import { getSystemInfo } from "./systemMonitor";
import type { MonitorSnapshot } from "../../shared/types";

export function getMonitorSnapshot(): MonitorSnapshot {
  return {
    timestamp: new Date().toISOString(),
    system: getSystemInfo(),
    gpu: getGpuInfo(),
  };
}
