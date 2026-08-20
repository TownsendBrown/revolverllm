import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { inComposeBackend } from "../../shared/runtimeMode";
import type { LocalSettings, RevolverConfig } from "../../shared/types";
import { loadConfig, saveConfig } from "./config";
import { readLocalSettings, saveLocalSettings } from "./paths";
import { loadRuntimeConfig, saveRuntimeConfig, type RuntimeConfig } from "./runtimeConfig";
import {
  loadServerConfig,
  saveServerConfig,
  type ServerConfig,
} from "./serverConfig";

export const SETTINGS_SCHEMA_VERSION = 1;

export type SettingsHost = "electron" | "compose";

export interface GatewaySettings {
  gatewayEnabled: boolean;
  host: string;
  port: number;
  gatewayApiKey: string | null;
  cors: boolean;
}

export interface DownloadSettings {
  dest: "hub" | "models";
  maxConcurrent: number;
}

export interface RevolverSettings {
  schemaVersion: number;
  host: SettingsHost;
  pathSettingsLocked: boolean;
  paths: RevolverConfig;
  inferenceDefaults: RuntimeConfig;
  gateway: GatewaySettings;
  guardrails: LocalSettings["modelLoadingGuardrails"];
  downloads: DownloadSettings;
  hfTokenSet: boolean;
  hasApiKey: boolean;
}

function settingsHost(): SettingsHost {
  return inComposeBackend() ? "compose" : "electron";
}

function gatewayFromServer(cfg: ServerConfig): GatewaySettings {
  return {
    gatewayEnabled: cfg.gatewayEnabled !== false,
    host: cfg.host,
    port: cfg.port,
    gatewayApiKey: cfg.gatewayApiKey,
    cors: cfg.cors,
  };
}

function readDownloadSettings(): DownloadSettings {
  const path = join(
    loadConfig().localRoot,
    ".internal",
    "download-settings.json",
  );
  const defaults: DownloadSettings = { dest: "models", maxConcurrent: 1 };
  if (!existsSync(path)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DownloadSettings>;
    return {
      dest: raw.dest === "hub" ? "hub" : "models",
      maxConcurrent: Math.max(1, Math.min(3, Number(raw.maxConcurrent) || 1)),
    };
  } catch {
    return defaults;
  }
}

function writeDownloadSettings(settings: DownloadSettings): void {
  const dir = join(loadConfig().localRoot, ".internal");
  const path = join(dir, "download-settings.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function loadSettings(opts?: { hfTokenSet?: boolean; hasApiKey?: boolean }): RevolverSettings {
  const host = settingsHost();
  const local = readLocalSettings();
  const paths = loadConfig();
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    host,
    pathSettingsLocked: host === "compose",
    paths,
    inferenceDefaults: loadRuntimeConfig(),
    gateway: gatewayFromServer(loadServerConfig()),
    guardrails: local.modelLoadingGuardrails,
    downloads: readDownloadSettings(),
    hfTokenSet: opts?.hfTokenSet ?? false,
    hasApiKey: opts?.hasApiKey ?? Boolean(loadServerConfig().gatewayApiKey),
  };
}

export type SettingsPatch = {
  paths?: Partial<RevolverConfig>;
  inferenceDefaults?: Partial<RuntimeConfig>;
  gateway?: Partial<GatewaySettings>;
  guardrails?: Partial<LocalSettings["modelLoadingGuardrails"]>;
  downloads?: Partial<DownloadSettings>;
};

export function saveSettings(patch: SettingsPatch): RevolverSettings {
  const host = settingsHost();
  if (host === "compose" && patch.paths) {
    throw new Error(
      "Model paths are locked in Docker Compose — set MODELS_DIR in .env and recreate the container",
    );
  }

  if (patch.paths) {
    const current = loadConfig();
    saveConfig({
      modelsDir: patch.paths.modelsDir ?? current.modelsDir,
      hubModelsDir: patch.paths.hubModelsDir ?? current.hubModelsDir,
      localRoot: patch.paths.localRoot ?? current.localRoot,
    });
  }

  if (patch.inferenceDefaults) {
    saveRuntimeConfig(patch.inferenceDefaults);
  }

  if (patch.gateway) {
    const g = patch.gateway;
    saveServerConfig({
      ...(g.gatewayEnabled !== undefined ? { gatewayEnabled: g.gatewayEnabled } : {}),
      ...(g.host !== undefined ? { host: g.host } : {}),
      ...(g.port !== undefined ? { port: g.port } : {}),
      ...(g.gatewayApiKey !== undefined ? { gatewayApiKey: g.gatewayApiKey } : {}),
      ...(g.cors !== undefined ? { cors: g.cors } : {}),
    });
  }

  if (patch.guardrails) {
    const local = readLocalSettings();
    saveLocalSettings({
      modelLoadingGuardrails: {
        ...local.modelLoadingGuardrails,
        ...patch.guardrails,
      },
    });
  }

  if (patch.downloads) {
    writeDownloadSettings({ ...readDownloadSettings(), ...patch.downloads });
  }

  return loadSettings();
}

export function jitStatusFromConfig(): {
  enabled: boolean;
  autoEvict: boolean;
  ttlSeconds: number;
} {
  const cfg = loadServerConfig();
  return {
    enabled: cfg.justInTimeModelLoading,
    autoEvict: cfg.autoEvict,
    ttlSeconds: cfg.jitModelTTL.enabled ? cfg.jitModelTTL.ttlSeconds : 0,
  };
}
