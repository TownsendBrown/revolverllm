import type { InferenceBackend } from "./types";

export interface BackendPackSpec {
  id: string;
  label: string;
  os: "linux" | "darwin" | "win32";
  cpuArch: string;
  backend: InferenceBackend;
  cudaArchitectures: string;
  matchComputeCaps: number[];
  expectSms?: string[];
  gpus?: string[];
  status?: string;
  binary?: string;
  libDir?: string;
}

export interface BackendCatalog {
  schemaVersion: number;
  llamaCppRepo: string;
  llamaCppTag: string;
  packs: BackendPackSpec[];
}

/** nvidia-smi `7.0` → 70; already-integer `70` passes through. */
export function parseComputeCap(raw: string): number | null {
  const t = raw.trim();
  const dotted = t.match(/^(\d+)\.(\d+)$/);
  if (dotted) return Number(dotted[1]) * 10 + Number(dotted[2]);
  if (/^\d{2,3}$/.test(t)) return Number(t);
  return null;
}

export function parseComputeCapList(raw: string | string[]): number[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/[,\s]+/);
  const out: number[] = [];
  for (const p of parts) {
    const n = parseComputeCap(p);
    if (n != null) out.push(n);
  }
  return out;
}

export function packMatchesComputeCap(pack: BackendPackSpec, cap: number): boolean {
  return pack.matchComputeCaps.includes(cap);
}

export function packMatchesAnyCap(pack: BackendPackSpec, caps: number[]): boolean {
  return caps.some((c) => packMatchesComputeCap(pack, c));
}

export function packIsLinuxCuda(pack: BackendPackSpec): boolean {
  return pack.os === "linux" && pack.backend === "cuda";
}

/**
 * Linux CUDA pack for native llama-server.
 * One fat SKU (`linux-cuda`) — pick it on Linux. Darwin / non-linux → null
 * (Metal is mac/, not backends/).
 */
export function pickBackendPack(
  packs: BackendPackSpec[],
  opts: {
    os: string;
    cpuArch?: string;
    computeCaps: number[];
    forcePackId?: string;
  },
): BackendPackSpec | null {
  if (opts.os === "darwin") return null;
  const pool = packs
    .filter((p) => packIsLinuxCuda(p))
    .filter((p) => !opts.cpuArch || !p.cpuArch || p.cpuArch === opts.cpuArch);
  if (opts.forcePackId) {
    return pool.find((p) => p.id === opts.forcePackId) ?? null;
  }
  if (pool.length === 1) return pool[0];
  if (!opts.computeCaps.length) return null;
  const hits = pool
    .filter((p) => packMatchesAnyCap(p, opts.computeCaps))
    .sort((a, b) => a.matchComputeCaps.length - b.matchComputeCaps.length);
  return hits[0] ?? null;
}

export function packBinaryRel(pack: Pick<BackendPackSpec, "binary">): string {
  return pack.binary ?? "bin/llama-server";
}

export function packLibRel(pack: Pick<BackendPackSpec, "libDir">): string {
  return pack.libDir ?? "lib";
}
