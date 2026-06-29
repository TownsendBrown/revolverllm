import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getRevolverRoot } from "./appRoot";

export interface RevolverConfig {
  modelsDir: string;
  hubModelsDir: string;
  localRoot: string;
}

const CONFIG_FILE = "config.json";

function defaultLocalRoot(): string {
  return process.env.REVOLVER_LOCAL_ROOT ?? join(process.env.HOME ?? "", ".revolver");
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

export function defaultConfig(): RevolverConfig {
  if (process.env.REVOLVER_MODELS_DIR) {
    return {
      modelsDir: process.env.REVOLVER_MODELS_DIR,
      hubModelsDir: process.env.REVOLVER_HUB_MODELS_DIR ?? join(process.env.REVOLVER_MODELS_DIR, "hub"),
      localRoot: process.env.REVOLVER_LOCAL_ROOT ?? join(process.env.REVOLVER_MODELS_DIR, ".revolver"),
    };
  }
  const localRoot = defaultLocalRoot();
  const modelsDir = readDownloadsFolderFromSettings(localRoot) ?? join(localRoot, "models");
  return {
    modelsDir,
    hubModelsDir: join(localRoot, "hub", "models"),
    localRoot,
  };
}

function configPath(): string {
  return join(getRevolverRoot(), CONFIG_FILE);
}

export function getConfigPath(): string {
  return configPath();
}

export function loadConfig(): RevolverConfig {
  const path = configPath();
  const defaults = defaultConfig();
  if (!existsSync(path)) {
    saveConfig(defaults);
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      modelsDir: raw.modelsDir ?? defaults.modelsDir,
      hubModelsDir: raw.hubModelsDir ?? defaults.hubModelsDir,
      localRoot: raw.localRoot ?? defaults.localRoot,
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(config: RevolverConfig): RevolverConfig {
  const path = configPath();
  mkdirSync(getRevolverRoot(), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return config;
}

export function getDataDir(): string {
  const dir = join(getRevolverRoot(), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}
