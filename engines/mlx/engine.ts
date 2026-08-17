import type { ServerDefinition } from "../../shared/types";
import { backendSupported, type InferenceEngine } from "../types";
import { MLX_CAPABILITIES, MLX_CONFIG_FIELDS } from "./capabilities";
import { buildMlxLoadEnv } from "./config";
import {
  MLX_CONTAINER_PORT,
  MLX_ENTRYPOINT_FILE,
  MLX_ENTRYPOINT_SCRIPT,
  mlxEnvFileName,
} from "./docker";
import { mlxMemoryEstimator } from "./memory";

export const mlxEngine: InferenceEngine = {
  id: "mlx",
  label: "MLX",
  description: "Apple Silicon via mlx-engine (safetensors / MLX quants). Native macOS only.",
  capabilities: MLX_CAPABILITIES,
  configFields: MLX_CONFIG_FIELDS,

  validateModel(model) {
    if (model.format !== "safetensors" && model.format !== "mlx") {
      return `MLX requires safetensors or MLX-format weights (got ${model.format})`;
    }
    if (!model.path) {
      return "MLX requires a local model directory or Hugging Face repo id";
    }
    return null;
  },

  supportsBackend(backend) {
    return backendSupported(MLX_CAPABILITIES, backend);
  },

  containerSpec(def: ServerDefinition) {
    return {
      image: "",
      containerPort: MLX_CONTAINER_PORT,
      entrypoint: { fileName: MLX_ENTRYPOINT_FILE, script: MLX_ENTRYPOINT_SCRIPT },
      env: {
        ENGINE: "mlx",
        MLX_ENV_FILE: mlxEnvFileName(def.id),
      },
      extraMounts: [],
      envFileName: mlxEnvFileName(def.id),
    };
  },

  buildLoadEnv: buildMlxLoadEnv,

  readiness() {
    return {
      readyMarkers: ["Starting httpd at", "server is listening"],
      errorMarkers: [
        {
          match: "does not exist",
          message: "MLX model not found — check MODEL path",
        },
        {
          match: "Couldn't instantiate the backend tokenizer",
          message: "Tokenizer files missing — re-download the model (include tokenizer.json)",
        },
      ],
      timeoutMs: 300_000,
      healthProbe: true,
      healthProbeIntervalMs: 5_000,
    };
  },

  idleLoadEnv() {
    return { ENGINE: "mlx", MODEL: "", MODEL_PATH: "" };
  },

  memory: mlxMemoryEstimator,
};
