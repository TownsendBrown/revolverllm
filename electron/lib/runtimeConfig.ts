import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./config";
import { clampContextLength, DEFAULT_CONTEXT_LENGTH } from "./contextLength";

export interface RuntimeConfig {
  contextLength: number;
  nGpuLayers: number;
  kvCacheDtype: string;
  backendId: string | null;
  lastModelId: string | null;
}

const DEFAULTS: RuntimeConfig = {
  contextLength: DEFAULT_CONTEXT_LENGTH,
  nGpuLayers: -1,
  kvCacheDtype: "f16",
  backendId: null,
  lastModelId: null,
};

function configPath(): string {
  return join(getDataDir(), "runtime-config.json");
}

function readRuntimeConfigFile(): RuntimeConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
    raw.contextLength = clampContextLength(raw.contextLength);
    return raw;
  } catch {
    return { ...DEFAULTS };
  }
}

export function loadRuntimeConfig(): RuntimeConfig {
  const path = configPath();
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
  return readRuntimeConfigFile();
}

export function saveRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
  const current = readRuntimeConfigFile();
  const next = { ...current, ...patch };
  if (patch.contextLength != null) {
    next.contextLength = clampContextLength(patch.contextLength);
  }
  writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}
