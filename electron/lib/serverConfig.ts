import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "./config";

export interface ServerConfig {
  port: number;
  host: string;
  cors: boolean;
  verbose: boolean;
  logLinesLimit: number;
  autoStartOnLaunch: boolean;
  justInTimeModelLoading: boolean;
  autoEvict: boolean;
  jitModelTTL: { enabled: boolean; ttlSeconds: number };
}

/**
 * Default server settings.
 * JIT default TTL is 60 minutes; Auto-Evict keeps at most 1 JIT model loaded.
 */
const DEFAULTS: ServerConfig = {
  port: 8081,
  host: "127.0.0.1",
  cors: false,
  verbose: true,
  logLinesLimit: 500,
  autoStartOnLaunch: false,
  justInTimeModelLoading: true,
  autoEvict: true,
  jitModelTTL: { enabled: true, ttlSeconds: 3600 },
};

function configPath(): string {
  return join(getDataDir(), "http-server-config.json");
}

function readServerConfigFile(): ServerConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...DEFAULTS,
      ...raw,
      jitModelTTL: { ...DEFAULTS.jitModelTTL, ...(raw.jitModelTTL ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function loadServerConfig(): ServerConfig {
  const path = configPath();
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
  return readServerConfigFile();
}

export function saveServerConfig(patch: Partial<ServerConfig>): ServerConfig {
  const next = { ...readServerConfigFile(), ...patch };
  writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

export function serverBaseUrl(cfg = loadServerConfig()): string {
  const host = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}

export function serverEndpoints(cfg = loadServerConfig()): string[] {
  const base = serverBaseUrl(cfg);
  return [
    `GET  ${base}/health`,
    `GET  ${base}/v1/models`,
    `POST ${base}/v1/chat/completions`,
    `POST ${base}/v1/completions`,
    `POST ${base}/v1/embeddings`,
  ];
}

/** Network address llama-server binds to. */
export function serverBindHost(cfg = loadServerConfig()): string {
  return cfg.host;
}
