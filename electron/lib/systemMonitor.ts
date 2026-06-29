import { readFileSync, statfsSync } from "fs";
import os from "os";

export interface SystemInfo {
  platform: string;
  hostname: string;
  cpuCount: number;
  cpuModel: string;
  cpuUsagePercent: number | null;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryFreeBytes: number;
  memoryUsedPercent: number;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskUsedPercent: number | null;
  uptimeSeconds: number;
}

let lastCpuSample: { idle: number; total: number; usage: number } | null = null;

function readLinuxCpuTimes(): { idle: number; total: number } | null {
  try {
    const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
    if (!line?.startsWith("cpu ")) return null;
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3]! + (parts[4] ?? 0);
    const total = parts.reduce((sum, n) => sum + n, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function cpuUsagePercent(): number | null {
  const sample = readLinuxCpuTimes();
  if (!sample) {
    const load = os.loadavg()[0] ?? 0;
    const count = os.cpus().length || 1;
    return Math.round(Math.min(100, (load / count) * 100) * 10) / 10;
  }
  if (!lastCpuSample) {
    lastCpuSample = { ...sample, usage: 0 };
    return null;
  }
  const idleDelta = sample.idle - lastCpuSample.idle;
  const totalDelta = sample.total - lastCpuSample.total;
  const usage =
    totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : lastCpuSample.usage;
  lastCpuSample = { idle: sample.idle, total: sample.total, usage };
  return Math.round(usage * 10) / 10;
}

function readMemInfo(): { swapTotal: number | null; swapUsed: number | null } {
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const kv = new Map<string, number>();
    for (const line of text.split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) kv.set(m[1]!, Number(m[2]!) * 1024);
    }
    const swapTotal = kv.get("SwapTotal") ?? null;
    const swapFree = kv.get("SwapFree") ?? null;
    const swapUsed =
      swapTotal != null && swapFree != null ? Math.max(0, swapTotal - swapFree) : null;
    return { swapTotal, swapUsed };
  } catch {
    return { swapTotal: null, swapUsed: null };
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

export function getSystemInfo(): SystemInfo {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const load = os.loadavg();
  const cpus = os.cpus();
  const swap = readMemInfo();
  const disk = rootDiskUsage();

  return {
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model.trim() ?? "Unknown",
    cpuUsagePercent: cpuUsagePercent(),
    loadAvg1: Math.round((load[0] ?? 0) * 100) / 100,
    loadAvg5: Math.round((load[1] ?? 0) * 100) / 100,
    loadAvg15: Math.round((load[2] ?? 0) * 100) / 100,
    memoryTotalBytes: totalMem,
    memoryUsedBytes: usedMem,
    memoryFreeBytes: freeMem,
    memoryUsedPercent: Math.round((usedMem / totalMem) * 1000) / 10,
    swapTotalBytes: swap.swapTotal,
    swapUsedBytes: swap.swapUsed,
    diskTotalBytes: disk.totalBytes,
    diskUsedBytes: disk.usedBytes,
    diskUsedPercent: disk.usedPercent,
    uptimeSeconds: Math.floor(os.uptime()),
  };
}
