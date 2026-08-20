import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getRevolverRoot } from "./appRoot";
import {
  getDataDir,
  loadConfig,
  saveConfig,
  type RevolverConfig,
} from "./config";
import type { LocalPaths, LocalSettings } from "./types";

export const SETTINGS_SCHEMA_VERSION = 1;

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
    repoRoot: getRevolverRoot(),
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
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
      downloadsFolder: raw.downloadsFolder ?? defaults.downloadsFolder,
      defaultContextLength: raw.defaultContextLength ?? defaults.defaultContextLength,
      enableLocalService: raw.enableLocalService ?? true,
      modelLoadingGuardrails: raw.modelLoadingGuardrails ?? defaults.modelLoadingGuardrails,
    };
  } catch {
    return defaults;
  }
}

export function saveLocalSettings(patch: Partial<LocalSettings>): LocalSettings {
  const current = readLocalSettings();
  const next: LocalSettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    modelLoadingGuardrails: {
      ...current.modelLoadingGuardrails,
      ...(patch.modelLoadingGuardrails ?? {}),
    },
  };
  const paths = getLocalPaths();
  mkdirSync(dirname(paths.settings), { recursive: true });
  writeFileSync(paths.settings, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function getDownloadsDir(): string {
  return loadConfig().modelsDir;
}

export function getHubModelsDir(): string {
  return loadConfig().hubModelsDir;
}

/** Roots the catalog should scan for downloaded weights (GGUF + HF trees). */
export function getModelScanRoots(): string[] {
  const roots = [getDownloadsDir(), getHubModelsDir()];
  const seen = new Set<string>();
  return roots.filter((root) => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

/** `{base}/{owner}/{name}` — GGUF and MLX share this layout. */
export function joinRepoDownloadDir(baseDir: string, repoId: string): string {
  const parts = repoId.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Invalid repo id");
  return join(baseDir, ...parts);
}

/**
 * Hugging Face downloads land under owner/name. `dest` picks modelsDir vs
 * hubModelsDir; default callers use modelsDir.
 */
export function modelDownloadDir(dest: "hub" | "models", repoId: string): string {
  const base = dest === "hub" ? getHubModelsDir() : getDownloadsDir();
  return joinRepoDownloadDir(base, repoId);
}

export function getHttpServerConfigPath(): string {
  return join(getDataDir(), "http-server-config.json");
}

export function getModelIndexCachePath(): string {
  return join(getLocalRoot(), ".internal", "model-index-cache.json");
}
