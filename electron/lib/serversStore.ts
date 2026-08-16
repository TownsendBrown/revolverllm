import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getDataDir } from "./config";
import { normalizeModelPath } from "./modelPaths";
import { effectiveGpuLayers } from "./vram";
import type { EngineId, InferenceBackend, GpuMode, ServerDefinition, ServerRuntimeMode } from "../../shared/types";

const BASE_PORT = 8082;

function storePath(): string {
  return join(getDataDir(), "servers.json");
}

interface ServersFile {
  schemaVersion?: number;
  nextPort: number;
  servers: ServerDefinition[];
}

const SERVERS_SCHEMA_VERSION = 1;

function normalizeDefinition(def: ServerDefinition): ServerDefinition {
  return {
    ...def,
    engine: def.engine ?? "llamacpp",
    apiKey: def.apiKey ?? null,
    modelPath: normalizeModelPath(def.modelPath),
    mmprojPath: def.mmprojPath ? normalizeModelPath(def.mmprojPath) : null,
    nGpuLayers: effectiveGpuLayers(def.backend, def.nGpuLayers),
    engineConfig: def.engineConfig ?? {},
  };
}

function readFile(): ServersFile {
  const path = storePath();
  if (!existsSync(path)) return { schemaVersion: SERVERS_SCHEMA_VERSION, nextPort: BASE_PORT, servers: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ServersFile;
    const servers = raw.servers.map(normalizeDefinition);
    const migrated =
      raw.schemaVersion !== SERVERS_SCHEMA_VERSION ||
      servers.some(
        (s, i) =>
          s.modelPath !== raw.servers[i]?.modelPath ||
          s.mmprojPath !== raw.servers[i]?.mmprojPath ||
          s.nGpuLayers !== raw.servers[i]?.nGpuLayers ||
          (s.apiKey ?? null) !== (raw.servers[i]?.apiKey ?? null),
      );
    const data = { ...raw, schemaVersion: SERVERS_SCHEMA_VERSION, servers };
    if (migrated) writeFile(data);
    return data;
  } catch {
    return { nextPort: BASE_PORT, servers: [] };
  }
}

function writeFile(data: ServersFile): void {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(storePath(), `${JSON.stringify(data, null, 2)}\n`);
}

export function listServerDefinitions(): ServerDefinition[] {
  return readFile().servers;
}

export function getServerDefinition(id: string): ServerDefinition | null {
  return readFile().servers.find((s) => s.id === id) ?? null;
}

export function allocatePort(): number {
  const data = readFile();
  const port = data.nextPort;
  data.nextPort = port + 1;
  writeFile(data);
  return port;
}

export function saveServerDefinition(def: ServerDefinition): ServerDefinition {
  const data = readFile();
  const idx = data.servers.findIndex((s) => s.id === def.id);
  if (idx >= 0) data.servers[idx] = def;
  else data.servers.push(def);
  writeFile(data);
  return def;
}

export function removeServerDefinition(id: string): boolean {
  const data = readFile();
  const before = data.servers.length;
  data.servers = data.servers.filter((s) => s.id !== id);
  if (data.servers.length === before) return false;
  writeFile(data);
  return true;
}

export function createServerDefinition(opts: {
  name: string;
  engine?: EngineId;
  backend: InferenceBackend;
  runtime?: ServerRuntimeMode;
  gpuDevices: number[];
  gpuMode: GpuMode;
  modelId: string;
  modelPath: string;
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype: string;
  engineConfig?: Record<string, unknown>;
  mmprojPath?: string | null;
  apiKey?: string | null;
}): ServerDefinition {
  const now = new Date().toISOString();
  const def: ServerDefinition = {
    id: randomUUID().slice(0, 8),
    name: opts.name,
    engine: opts.engine ?? "llamacpp",
    backend: opts.backend,
    runtime: opts.runtime,
    gpuDevices: opts.gpuDevices,
    gpuMode: opts.gpuMode,
    modelId: opts.modelId,
    modelPath: opts.modelPath,
    mmprojPath: opts.mmprojPath ?? null,
    contextLength: opts.contextLength,
    nGpuLayers: opts.nGpuLayers,
    kvCacheDtype: opts.kvCacheDtype,
    engineConfig: opts.engineConfig ?? {},
    hostPort: allocatePort(),
    apiKey: opts.apiKey ?? null,
    createdAt: now,
    updatedAt: now,
  };
  return saveServerDefinition(def);
}
