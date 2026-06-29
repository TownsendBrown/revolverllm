import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getRevolverRoot } from "./appRoot";
import {
  getDataDir,
  loadConfig,
  saveConfig,
  type RevolverConfig,
} from "./config";
import type { LocalPaths, LocalSettings } from "./types";

export { getRevolverRoot, getDataDir, loadConfig, saveConfig };
export type { RevolverConfig };

export function getLocalRoot(): string {
  return loadConfig().localRoot;
}

export function getLocalPaths(): LocalPaths {
  const cfg = loadConfig();
  const root = cfg.localRoot;
  return {
    root,
    hubModels: cfg.hubModelsDir,
    downloads: cfg.modelsDir,
    internal: join(root, ".internal"),
    settings: join(root, "settings.json"),
    configPath: join(getRevolverRoot(), "config.json"),
    dataDir: getDataDir(),
  };
}

export function readLocalSettings(): LocalSettings {
  const paths = getLocalPaths();
  const defaults: LocalSettings = {
    downloadsFolder: paths.downloads,
    defaultContextLength: { type: "custom", value: 8192 },
    enableLocalService: true,
    modelLoadingGuardrails: { mode: "high", customThresholdBytes: 4294967296 },
  };
  if (!existsSync(paths.settings)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(paths.settings, "utf8"));
    return {
      downloadsFolder: raw.downloadsFolder ?? defaults.downloadsFolder,
      defaultContextLength: raw.defaultContextLength ?? defaults.defaultContextLength,
      enableLocalService: raw.enableLocalService ?? true,
      modelLoadingGuardrails: raw.modelLoadingGuardrails ?? defaults.modelLoadingGuardrails,
    };
  } catch {
    return defaults;
  }
}

export function getDownloadsDir(): string {
  return loadConfig().modelsDir;
}

export function getHubModelsDir(): string {
  return loadConfig().hubModelsDir;
}

export function getHttpServerConfigPath(): string {
  return join(getDataDir(), "http-server-config.json");
}

export function getModelIndexCachePath(): string {
  return join(getLocalRoot(), ".internal", "model-index-cache.json");
}
