import { existsSync } from "fs";
import { isAbsolute, join, relative } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config";

function stripTrailingSlash(p: string): string {
  return p.replace(/\/$/, "");
}

export function toFsPath(pathOrUrl: string): string {
  return pathOrUrl.startsWith("file:") ? fileURLToPath(pathOrUrl) : pathOrUrl;
}

/** Path models live at inside the backend / spawned llama containers. */
function containerModelsRoot(): string {
  return stripTrailingSlash(process.env.REVOLVER_MODELS_DIR ?? loadConfig().modelsDir);
}

/** Host bind source for the models volume (Docker only). */
function hostModelsRoot(): string {
  return stripTrailingSlash(process.env.REVOLVER_HOST_MODELS_DIR ?? containerModelsRoot());
}

/**
 * Map a host-side model path to the path visible inside spawned llama containers.
 * Compose mounts `REVOLVER_HOST_MODELS_DIR` → `/models`, so MODEL_PATH must use
 * the container path, not the host path persisted in older server definitions.
 */
export function toContainerModelPath(modelPath: string): string {
  if (!modelPath) return modelPath;
  const containerRoot = containerModelsRoot();
  const normalized = modelPath.replace(/\\/g, "/");

  if (normalized === containerRoot || normalized.startsWith(`${containerRoot}/`)) {
    return normalized;
  }

  const hostRoot = hostModelsRoot();
  if (normalized.startsWith(`${hostRoot}/`)) {
    return `${containerRoot}${normalized.slice(hostRoot.length)}`;
  }

  if (!isAbsolute(normalized) && !normalized.startsWith("/")) {
    return join(containerRoot, normalized);
  }

  return normalized;
}

/**
 * Normalize for backend filesystem access (stat, GGUF metadata reads).
 * In Docker the backend only sees `/models`, not the host bind source.
 */
export function normalizeModelPath(modelPath: string): string {
  if (!modelPath) return modelPath;
  const candidate = toContainerModelPath(modelPath);
  if (existsSync(candidate)) return candidate;

  const hostRoot = process.env.REVOLVER_HOST_MODELS_DIR
    ? stripTrailingSlash(process.env.REVOLVER_HOST_MODELS_DIR)
    : null;
  if (hostRoot && modelPath.replace(/\\/g, "/").startsWith(`${hostRoot}/`)) {
    const rel = relative(hostRoot, modelPath);
    const viaMount = join(containerModelsRoot(), rel);
    if (existsSync(viaMount)) return viaMount;
  }

  if (existsSync(modelPath)) return modelPath;
  return candidate;
}
