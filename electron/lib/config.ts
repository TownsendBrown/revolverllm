import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import { getRevolverRoot } from "./appRoot";

export interface RevolverConfig {
  modelsDir: string;
  hubModelsDir: string;
  localRoot: string;
}

const CONFIG_FILE = "config.json";

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** Platform-native Revolver data root (Electron desktop). */
export function platformLocalRoot(): string {
  if (process.env.REVOLVER_LOCAL_ROOT) return process.env.REVOLVER_LOCAL_ROOT;

  const home = homeDir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Revolver");
    case "linux":
      return join(home, ".revolver");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Revolver");
    }
    default:
      return join(home, ".revolver");
  }
}

function readDownloadsFolderFromSettings(localRoot: string): string | null {
  const settingsPath = join(localRoot, "settings.json");
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    return raw.downloadsFolder ?? null;
  } catch {
    return null;
  }
}

/** Defaults from env overrides or platform layout. */
export function platformDefaultConfig(): RevolverConfig {
  if (process.env.REVOLVER_MODELS_DIR) {
    const modelsDir = process.env.REVOLVER_MODELS_DIR;
    return {
      modelsDir,
      hubModelsDir: process.env.REVOLVER_HUB_MODELS_DIR ?? join(modelsDir, "hub"),
      localRoot: process.env.REVOLVER_LOCAL_ROOT ?? join(modelsDir, ".revolver"),
    };
  }

  const localRoot = platformLocalRoot();
  const modelsDir = readDownloadsFolderFromSettings(localRoot) ?? join(localRoot, "models");
  return {
    modelsDir,
    hubModelsDir: join(localRoot, "hub", "models"),
    localRoot,
  };
}

/** @deprecated Use platformDefaultConfig — kept for callers expecting the old name. */
export function defaultConfig(): RevolverConfig {
  return platformDefaultConfig();
}

function isForeignPlatformPath(path: string): boolean {
  if (!path) return true;
  if (process.platform === "darwin") {
    return path.startsWith("/home/") || /^[A-Za-z]:\\/.test(path);
  }
  if (process.platform === "linux") {
    return path.includes("/Users/") || path.includes("Application Support");
  }
  if (process.platform === "win32") {
    return path.startsWith("/home/") || path.startsWith("/Users/");
  }
  return false;
}

function configPathValid(cfg: RevolverConfig): boolean {
  if (!isAbsolute(cfg.modelsDir) || !isAbsolute(cfg.localRoot) || !isAbsolute(cfg.hubModelsDir)) {
    return false;
  }
  if (isForeignPlatformPath(cfg.modelsDir) || isForeignPlatformPath(cfg.localRoot)) {
    return false;
  }
  return true;
}

function configsEqual(a: RevolverConfig, b: RevolverConfig): boolean {
  return (
    a.modelsDir === b.modelsDir &&
    a.hubModelsDir === b.hubModelsDir &&
    a.localRoot === b.localRoot
  );
}

function mergeStoredConfig(raw: Record<string, unknown>, defaults: RevolverConfig): RevolverConfig {
  const cfg: RevolverConfig = {
    modelsDir: typeof raw.modelsDir === "string" ? raw.modelsDir : defaults.modelsDir,
    hubModelsDir: typeof raw.hubModelsDir === "string" ? raw.hubModelsDir : defaults.hubModelsDir,
    localRoot: typeof raw.localRoot === "string" ? raw.localRoot : defaults.localRoot,
  };
  if (configPathValid(cfg)) return cfg;
  return defaults;
}

export function ensureModelDirectories(cfg: RevolverConfig): void {
  mkdirSync(cfg.modelsDir, { recursive: true });
  mkdirSync(cfg.hubModelsDir, { recursive: true });
  mkdirSync(cfg.localRoot, { recursive: true });
  mkdirSync(join(cfg.localRoot, ".internal"), { recursive: true });
  const dataDir = getDataDir();
  mkdirSync(join(dataDir, "llama-config"), { recursive: true });
}

function configPath(): string {
  return join(getRevolverRoot(), CONFIG_FILE);
}

export function getConfigPath(): string {
  return configPath();
}

export function loadConfig(): RevolverConfig {
  const defaults = platformDefaultConfig();
  const path = configPath();
  let cfg = defaults;
  let shouldSave = !existsSync(path);

  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const stored: RevolverConfig = {
        modelsDir: typeof raw.modelsDir === "string" ? raw.modelsDir : defaults.modelsDir,
        hubModelsDir: typeof raw.hubModelsDir === "string" ? raw.hubModelsDir : defaults.hubModelsDir,
        localRoot: typeof raw.localRoot === "string" ? raw.localRoot : defaults.localRoot,
      };
      cfg = mergeStoredConfig(raw, defaults);
      if (!configsEqual(cfg, stored)) shouldSave = true;
    } catch {
      cfg = defaults;
      shouldSave = true;
    }
  }

  ensureModelDirectories(cfg);
  if (shouldSave) saveConfig(cfg);
  return cfg;
}

export function saveConfig(config: RevolverConfig): RevolverConfig {
  const path = configPath();
  mkdirSync(getRevolverRoot(), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  ensureModelDirectories(config);
  return config;
}

export function getDataDir(): string {
  const dir = join(getRevolverRoot(), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Call once at Electron startup — loads config, creates folders, exports paths to env. */
export function initElectronConfig(): RevolverConfig {
  const cfg = loadConfig();
  if (!process.env.REVOLVER_HOST_MODELS_DIR) {
    process.env.REVOLVER_HOST_MODELS_DIR = cfg.modelsDir;
  }
  if (!process.env.REVOLVER_HUB_MODELS_DIR) {
    process.env.REVOLVER_HUB_MODELS_DIR = cfg.hubModelsDir;
  }
  if (!process.env.REVOLVER_LOCAL_ROOT) {
    process.env.REVOLVER_LOCAL_ROOT = cfg.localRoot;
  }
  return cfg;
}
