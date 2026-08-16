import type { ServerDefinition, ServerRuntimeMode } from "./types";

export type ResolvedRuntime = "docker" | "native" | "metal";

/** True when the control plane itself is the Compose backend container. */
export function inComposeBackend(): boolean {
  return process.env.REVOLVER_COMPOSE === "1";
}

export function defaultRuntimeMode(): ServerRuntimeMode {
  return process.env.REVOLVER_RUNTIME === "native" ? "native" : "docker";
}

/**
 * Metal always uses the macOS host-agent. Otherwise honor `def.runtime`,
 * then `REVOLVER_RUNTIME`, then docker.
 */
export function resolveServerRuntime(
  def: Pick<ServerDefinition, "backend" | "runtime" | "engine">,
): ResolvedRuntime {
  if (def.engine === "mlx") return "native";
  if (def.backend === "metal") return "metal";
  if (def.runtime === "native" || def.runtime === "docker") return def.runtime;
  return "docker";
}

export function isNativeRuntime(
  def: Pick<ServerDefinition, "backend" | "runtime" | "engine">,
): boolean {
  return resolveServerRuntime(def) === "native";
}

/** Native llama-server, MLX, and Metal host-agent see host filesystem paths. */
export function usesHostModelPaths(
  def: Pick<ServerDefinition, "backend" | "runtime" | "engine">,
): boolean {
  const runtime = resolveServerRuntime(def);
  return runtime === "native" || runtime === "metal";
}

/**
 * CUDA_VISIBLE_DEVICES for the inference process.
 * Docker `--gpus device=` renumbers cards to 0..n-1; native uses host indices.
 */
export function cudaVisibleDevices(
  def: Pick<ServerDefinition, "backend" | "runtime" | "gpuDevices" | "engine">,
): string | undefined {
  if (def.backend !== "cuda" || !def.gpuDevices.length) return undefined;
  if (resolveServerRuntime(def) === "docker") {
    return def.gpuDevices.map((_, i) => String(i)).join(",");
  }
  return def.gpuDevices.join(",");
}

export function rocmVisibleDevices(
  def: Pick<ServerDefinition, "backend" | "gpuDevices">,
): string | undefined {
  if (def.backend !== "rocm" || !def.gpuDevices.length) return undefined;
  return def.gpuDevices.join(",");
}

/** `*_VISIBLE_DEVICES` fragment written into the engine env file. */
export function visibleDeviceEnv(
  def: Pick<ServerDefinition, "backend" | "runtime" | "gpuDevices" | "engine">,
): Record<string, string> {
  const env: Record<string, string> = {};
  const cuda = cudaVisibleDevices(def);
  if (cuda) env.CUDA_VISIBLE_DEVICES = cuda;
  const hip = rocmVisibleDevices(def);
  if (hip) {
    env.HIP_VISIBLE_DEVICES = hip;
    env.ROCR_VISIBLE_DEVICES = hip;
  }
  return env;
}
