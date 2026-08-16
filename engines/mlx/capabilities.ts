import type { EngineCapabilities, EngineConfigField } from "../../shared/types";

export const MLX_CAPABILITIES: EngineCapabilities = {
  formats: ["safetensors", "mlx"],
  sources: ["local", "huggingface"],
  supportsMetal: true,
  supportsCUDA: false,
  supportsROCm: false,
  supportsVulkan: false,
  supportsCPU: true,
  supportsMultiGPU: false,
  supportsNative: true,
  api: "openai",
};

export const MLX_CONFIG_FIELDS: EngineConfigField[] = [
  {
    key: "adapter_path",
    label: "LoRA adapter path",
    type: "text",
    default: "",
    hint: "Optional mlx-lm --adapter-path (relative or absolute)",
  },
];
