import type { EngineCapabilities, EngineConfigField } from "../../shared/types";

export const LLAMACPP_CAPABILITIES: EngineCapabilities = {
  formats: ["gguf"],
  sources: ["local"],
  supportsMetal: true,
  supportsCUDA: true,
  supportsROCm: true,
  supportsVulkan: true,
  supportsCPU: true,
  supportsMultiGPU: true,
  api: "openai",
};

/**
 * llama.cpp settings (GPU layers, KV cache dtype, context) are first-class
 * ServerDefinition fields for backward compatibility, so there are no extra
 * dynamically-rendered fields.
 */
export const LLAMACPP_CONFIG_FIELDS: EngineConfigField[] = [];
