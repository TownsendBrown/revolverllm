import type { EngineCapabilities, EngineConfigField } from "../../shared/types";

/** sasha0552 vLLM 0.9.x on Pascal (SM 6.x) — safetensors only; no BF16, AWQ/GPTQ, or GGUF. */
export const VLLM_LEGACY_CAPABILITIES: EngineCapabilities = {
  formats: ["safetensors"],
  sources: ["local", "huggingface"],
  supportsMetal: false,
  supportsCUDA: true,
  supportsROCm: false,
  supportsVulkan: false,
  supportsCPU: false,
  supportsMultiGPU: true,
  api: "openai",
};

export const VLLM_LEGACY_CONFIG_FIELDS: EngineConfigField[] = [
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
    default: "half",
    options: [
      { value: "half", label: "half (FP16, recommended for Pascal)" },
      { value: "float16", label: "float16" },
      { value: "float", label: "float (FP32 — required for Gemma 2)" },
    ],
    hint: "Pascal has no bfloat16. Use half/float16 for most models; Gemma 2 auto-selects float32",
  },
  {
    key: "enforce_eager",
    label: "Enforce eager mode",
    type: "boolean",
    default: true,
    hint: "Required on Pascal — disable CUDA graphs (slower but stable on SM 6.x)",
  },
];
