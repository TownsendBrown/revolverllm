import { execFileSync } from "child_process";
import { statfsSync } from "fs";
import os from "os";
import type { GpuInfo, MonitorSnapshot, SystemInfo } from "../../../shared/types.js";

function readDarwinCpuUsage(): number | null {
  const load = os.loadavg()[0] ?? 0;
  const count = os.cpus().length || 1;
  return Math.round(Math.min(100, (load / count) * 100) * 10) / 10;
}

function chipName(): string {
  try {
    return execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim();
  } catch {
    return "Apple Silicon";
  }
}

function rootDiskUsage(): {
  totalBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
} {
  try {
    const stat = statfsSync("/");
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bfree * stat.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      totalBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
    };
  } catch {
    return { totalBytes: null, usedBytes: null, usedPercent: null };
  }
}

export function getHostSystemInfo(): SystemInfo {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const load = os.loadavg();
  const cpus = os.cpus();
  const disk = rootDiskUsage();

  return {
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model.trim() ?? chipName(),
    cpuUsagePercent: readDarwinCpuUsage(),
    loadAvg1: Math.round((load[0] ?? 0) * 100) / 100,
    loadAvg5: Math.round((load[1] ?? 0) * 100) / 100,
    loadAvg15: Math.round((load[2] ?? 0) * 100) / 100,
    memoryTotalBytes: totalMem,
    memoryUsedBytes: usedMem,
    memoryFreeBytes: freeMem,
    memoryUsedPercent: Math.round((usedMem / totalMem) * 1000) / 10,
    swapTotalBytes: null,
    swapUsedBytes: null,
    diskTotalBytes: disk.totalBytes,
    diskUsedBytes: disk.usedBytes,
    diskUsedPercent: disk.usedPercent,
    uptimeSeconds: Math.floor(os.uptime()),
  };
}

export function getHostGpuInfo(): GpuInfo {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const name = `${chipName()} (Metal)`;
  const usedPercent = total > 0 ? Math.round((used / total) * 1000) / 10 : null;

  return {
    available: true,
    deviceCount: 1,
    totalVramBytes: total,
    totalFreeVramBytes: free,
    devices: [
      {
        index: 0,
        name,
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

export function getHostMonitorSnapshot(): MonitorSnapshot {
  return {
    timestamp: new Date().toISOString(),
    system: getHostSystemInfo(),
    gpu: getHostGpuInfo(),
  };
}
