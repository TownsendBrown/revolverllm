import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export interface ServerDefinition {
  id: string;
  name: string;
  modelPath: string;
  contextLength: number;
  nGpuLayers: number;
  hostPort: number;
  mmprojPath: string | null;
  kvCacheDtype: string;
  createdAt: string;
  updatedAt: string;
}

interface StoreFile {
  servers: ServerDefinition[];
  nextPort: number;
}

const CONFIG_DIR = process.env.LLAMA_CONFIG_DIR ?? "/config";
const STORE_PATH = join(CONFIG_DIR, "servers.json");

function defaultStore(): StoreFile {
  return { servers: [], nextPort: Number(process.env.LLAMA_BASE_PORT ?? 8082) };
}

function readStore(): StoreFile {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(STORE_PATH)) return defaultStore();
  try {
    return { ...defaultStore(), ...JSON.parse(readFileSync(STORE_PATH, "utf8")) };
  } catch {
    return defaultStore();
  }
}

function writeStore(store: StoreFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function listServers(): ServerDefinition[] {
  return readStore().servers;
}

export function getServer(id: string): ServerDefinition | null {
  return readStore().servers.find((s) => s.id === id) ?? null;
}

export function createServer(opts: {
  name?: string;
  modelPath: string;
  contextLength?: number;
  nGpuLayers?: number;
  mmprojPath?: string | null;
  kvCacheDtype?: string;
}): ServerDefinition {
  const store = readStore();
  const id = randomUUID().slice(0, 8);
  const port = store.nextPort;
  store.nextPort = port + 1;
  const def: ServerDefinition = {
    id,
    name: opts.name?.trim() || `metal-${id}`,
    modelPath: opts.modelPath,
    contextLength: opts.contextLength ?? 8192,
    nGpuLayers: opts.nGpuLayers ?? -1,
    hostPort: port,
    mmprojPath: opts.mmprojPath ?? null,
    kvCacheDtype: opts.kvCacheDtype ?? "f16",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.servers.push(def);
  writeStore(store);
  return def;
}

export function deleteServer(id: string): boolean {
  const store = readStore();
  const before = store.servers.length;
  store.servers = store.servers.filter((s) => s.id !== id);
  if (store.servers.length === before) return false;
  writeStore(store);
  return true;
}

export function envFileName(serverId: string): string {
  return `llama-load-${serverId}.env`;
}

/** Write load env compatible with Revolver / mac entrypoint. */
export function writeLoadEnv(def: ServerDefinition): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const kv = (def.kvCacheDtype || "f16").toLowerCase();
  const quantKv = kv !== "f16";
  const lines: Record<string, string | number> = {
    MODEL_PATH: toContainerModelPath(def.modelPath),
    CTX_SIZE: def.contextLength,
    N_GPU_LAYERS: def.nGpuLayers,
    LLAMA_HOST: "0.0.0.0",
    LLAMA_PORT: 8080,
    BACKEND: "metal",
    REASONING: "off",
    N_PARALLEL: 4,
    KV_UNIFIED: "1",
  };
  if (def.mmprojPath) lines.MMPROJ_PATH = toContainerModelPath(def.mmprojPath);
  if (quantKv) {
    lines.FLASH_ATTN = "on";
    lines.CACHE_TYPE_K = kv;
    lines.CACHE_TYPE_V = kv;
  } else {
    lines.FLASH_ATTN = "auto";
  }
  const body = Object.entries(lines)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(join(CONFIG_DIR, envFileName(def.id)), `${body}\n`);
}

export function clearLoadEnv(serverId: string): void {
  writeFileSync(join(CONFIG_DIR, envFileName(serverId)), "MODEL_PATH=\n");
}

function toContainerModelPath(modelPath: string): string {
  const modelsDir = process.env.REVOLVER_MODELS_DIR ?? "/models";
  const hostDir = process.env.REVOLVER_HOST_MODELS_DIR ?? modelsDir;
  const norm = modelPath.replace(/\\/g, "/");
  if (norm.startsWith(`${hostDir}/`)) {
    return `${modelsDir}${norm.slice(hostDir.length)}`;
  }
  if (norm.startsWith(`${modelsDir}/`)) return norm;
  if (!norm.startsWith("/")) return `${modelsDir}/${norm}`;
  return norm;
}
