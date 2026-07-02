import { execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { promisify } from "util";
import { getRevolverRoot } from "../electron/lib/appRoot";

const execFileAsync = promisify(execFile);

export type HostOs = "darwin" | "linux" | "win32" | "other";

export interface HostPaths {
  modelsDir: string;
  hubModelsDir: string;
  localRoot: string;
  repoRoot: string;
}

function remapPrefix(path: string, containerPrefix: string, hostPrefix: string): string | null {
  if (path === containerPrefix) return hostPrefix;
  const prefix = containerPrefix.endsWith("/") ? containerPrefix : `${containerPrefix}/`;
  if (path.startsWith(prefix)) return hostPrefix + path.slice(containerPrefix.length);
  return null;
}

/** Map container-visible paths to host paths when Revolver runs in Docker. */
export function resolveHostPath(
  configPath: string,
  cfg: { modelsDir: string; hubModelsDir: string; localRoot: string },
): string {
  if (process.env.REVOLVER_DOCKER !== "1") return configPath;

  const hostModels = process.env.REVOLVER_HOST_MODELS_DIR;
  if (!hostModels) return configPath;

  const containerModels = process.env.REVOLVER_MODELS_DIR ?? cfg.modelsDir;
  const fromModels = remapPrefix(configPath, containerModels, hostModels);
  if (fromModels) return fromModels;

  const containerHub = process.env.REVOLVER_HUB_MODELS_DIR ?? cfg.hubModelsDir;
  const hostHub = join(hostModels, "hub");
  const fromHub = remapPrefix(configPath, containerHub, hostHub);
  if (fromHub) return fromHub;

  const containerLocal = process.env.REVOLVER_LOCAL_ROOT ?? cfg.localRoot;
  const hostLocal = join(hostModels, ".revolver");
  const fromLocal = remapPrefix(configPath, containerLocal, hostLocal);
  if (fromLocal) return fromLocal;

  return configPath;
}

/** Host-visible Revolver repo root (codebase). Used for “open data folder” in the UI. */
export function resolveRepoHostPath(): string {
  if (process.env.REVOLVER_DOCKER !== "1") {
    return getRevolverRoot();
  }

  const hostRoot = process.env.REVOLVER_HOST_ROOT;
  if (hostRoot && isAbsolute(hostRoot)) return hostRoot;

  const hostModels = process.env.REVOLVER_HOST_MODELS_DIR;
  if (hostModels && isAbsolute(hostModels)) {
    const parent = dirname(hostModels);
    if (parent !== hostModels && (hostModels.endsWith("/models") || hostModels.endsWith("\\models"))) {
      return parent;
    }
  }

  return hostRoot ?? getRevolverRoot();
}

export function hostPathsForDocker(
  cfg: { modelsDir: string; hubModelsDir: string; localRoot: string },
): HostPaths | undefined {
  if (process.env.REVOLVER_DOCKER !== "1") return undefined;
  const hostModels = process.env.REVOLVER_HOST_MODELS_DIR;
  if (!hostModels || !isAbsolute(hostModels)) return undefined;
  return {
    modelsDir: hostModels,
    hubModelsDir: resolveHostPath(cfg.hubModelsDir, cfg),
    localRoot: resolveHostPath(cfg.localRoot, cfg),
    repoRoot: resolveRepoHostPath(),
  };
}

export function runtimeHostOs(): HostOs {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return "other";
}

/** Open a host path via OS utilities (server / host-agent). Empty string = success. */
export async function openPathOnHost(hostPath: string): Promise<string> {
  if (!existsSync(hostPath)) return "Path not found";

  const isDir = statSync(hostPath).isDirectory();
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      await execFileAsync("open", isDir ? [hostPath] : ["-R", hostPath]);
      return "";
    }
    if (platform === "linux") {
      await execFileAsync("xdg-open", [hostPath]);
      return "";
    }
    if (platform === "win32") {
      await execFileAsync("explorer", [isDir ? hostPath : `/select,${hostPath}`]);
      return "";
    }
    return `Unsupported platform: ${platform}`;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return platform === "linux"
        ? "xdg-open not found (install xdg-utils)"
        : "System open utility not found";
    }
    return err.message ?? String(e);
  }
}
