import { normalizeModelPath } from "../../electron/lib/modelPaths";
import { usesHostModelPaths } from "../../shared/runtimeMode";
import type { ServerDefinition } from "../../shared/types";
import type { LoadEnvPlan } from "../types";
import { MLX_CONTAINER_PORT } from "./docker";

function adapterPath(def: ServerDefinition): string | undefined {
  const raw = def.engineConfig?.adapter_path;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/** Env-file contents nativeSupervisor reads to spawn revolver_mlx_server. */
export function buildMlxLoadEnv(def: ServerDefinition): LoadEnvPlan {
  const modelPath = def.modelPath.includes("/") && !def.modelPath.startsWith("/")
    ? def.modelPath
    : normalizeModelPath(def.modelPath);
  const hostPaths = usesHostModelPaths(def);
  const port = hostPaths ? def.hostPort : MLX_CONTAINER_PORT;
  const adapter = adapterPath(def);

  return {
    env: {
      ENGINE: "mlx",
      MODEL: modelPath,
      MODEL_PATH: modelPath,
      MLX_HOST: "127.0.0.1",
      MLX_PORT: port,
      CTX_SIZE: def.contextLength,
      BACKEND: def.backend,
      ADAPTER_PATH: adapter,
      API_KEY: def.apiKey ?? undefined,
    },
    logLines: [
      `[revolver] engine=mlx model=${modelPath} ctx=${def.contextLength} port=${port}`,
    ],
  };
}
