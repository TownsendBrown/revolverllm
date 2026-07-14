import type { EngineCapabilities, EngineConfigField } from "../../shared/types";

export const VLLM_CAPABILITIES: EngineCapabilities = {
  formats: ["safetensors", "awq", "gptq", "gguf"],
  sources: ["local", "huggingface"],
  supportsMetal: false,
  supportsCUDA: true,
  supportsROCm: false,
  supportsVulkan: false,
  supportsCPU: false,
  supportsMultiGPU: true,
  api: "openai",
};

export const VLLM_CONFIG_FIELDS: EngineConfigField[] = [
  {
    key: "gpu_memory_utilization",
    label: "GPU memory utilization",
    type: "number",
    default: 0.9,
    min: 0.1,
    max: 0.99,
    step: 0.05,
    hint: "Fraction of GPU VRAM vLLM may use per device",
  },
  {
    key: "dtype",
    label: "Dtype",
    type: "select",
    default: "auto",
    options: [
      { value: "auto", label: "Auto" },
      { value: "float16", label: "float16" },
      { value: "bfloat16", label: "bfloat16" },
    ],
  },
  {
    key: "enforce_eager",
    label: "Enforce eager mode",
    type: "boolean",
    default: false,
    hint: "Disable CUDA graphs (slower, useful for debugging)",
  },
];
