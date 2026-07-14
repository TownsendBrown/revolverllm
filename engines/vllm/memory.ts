import { readHfConfig } from "../../electron/lib/hfModels";
import { clampContextLength } from "../../electron/lib/contextLength";
import { normalizeModelPath } from "../../electron/lib/modelPaths";
import { normalizeGgufMeta, readGgufMetadata, resolveModelRef } from "../../electron/lib/models";
import { estimateVram } from "../../electron/lib/vram";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { MemoryEstimateRequest, MemoryEstimateResult, MemoryEstimator } from "../types";

function minBytes(values: number[]): number | null {
  return values.length ? Math.min(...values) : null;
}

function dirWeightBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(safetensors|bin|pt)$/i.test(ent.name)) total += statSync(p).size;
    }
  };
  try {
    walk(path);
    return total || statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * vLLM estimator: model weights (split by tensor parallel) + KV cache from
 * HF config when available. Conservative when architecture metadata is missing.
 */
export const vllmMemoryEstimator: MemoryEstimator = {
  async estimate(req: MemoryEstimateRequest): Promise<MemoryEstimateResult> {
    const ref = req.modelId ? resolveModelRef(req.modelId) : resolveModelRef(req.model.path);
    const modelPath = ref.source === "local" ? normalizeModelPath(ref.path) : ref.path;

    const tp = Math.max(1, req.gpuDeviceCount ?? (req.gpuDevices.length || 1));
    const devices = req.gpuDevices;
    const scopedFree = devices.length ? devices.reduce((s, d) => s + d.freeBytes, 0) : null;
    const scopedCapacity = devices.length ? devices.reduce((s, d) => s + d.totalBytes, 0) : null;

    if (ref.format === "gguf" && ref.source === "local") {
      const meta = normalizeGgufMeta(await readGgufMetadata(modelPath));
      const modelMax = Number(meta.context_length ?? meta.contextLength ?? 0) || null;
      const ctx = clampContextLength(req.contextLength, modelMax);
      const estimate = estimateVram({
        modelFileBytes: statSync(modelPath).size,
        ggufMeta: meta,
        contextLength: ctx,
        nGpuLayers: -1,
        kvCacheDtype: "f16",
        availableVramBytes: scopedFree,
        minGpuFreeBytes: minBytes(devices.map((d) => d.freeBytes)),
        capacityVramBytes: scopedCapacity,
        minGpuCapacityBytes: minBytes(devices.map((d) => d.totalBytes)),
        gpuDeviceCount: tp,
        backend: req.backend ?? "cuda",
      });
      return { estimate, contextLength: ctx, modelMaxContext: modelMax };
    }

    const weightBytes = ref.source === "local" ? dirWeightBytes(modelPath) : 0;

    const config = ref.source === "local" ? readHfConfig(modelPath) : null;
    const hidden = Number(config?.hidden_size ?? config?.n_embd ?? 4096);
    const layers = Number(config?.num_hidden_layers ?? config?.n_layer ?? 32);
    const kvHeads = Number(config?.num_key_value_heads ?? config?.num_attention_heads ?? 8);
    const heads = Number(config?.num_attention_heads ?? 32);
    const headDim = hidden / Math.max(heads, 1);

    const modelMax = Number(config?.max_position_embeddings ?? config?.model_max_length ?? 0) || null;
    const ctx = clampContextLength(req.contextLength, modelMax);

    const meta = {
      num_layers: layers,
      embedding_length: hidden,
      num_attention_heads: heads,
      num_key_value_heads: kvHeads,
      key_length: headDim,
      value_length: headDim,
      source: config ? "hf-config" : "estimate",
    };

    const fileBytes = weightBytes > 0 ? weightBytes : Math.max(req.model.path.length * 1, 8 * 1024 ** 3);
    const estimate = estimateVram({
      modelFileBytes: fileBytes,
      ggufMeta: meta,
      contextLength: ctx,
      nGpuLayers: -1,
      kvCacheDtype: "f16",
      availableVramBytes: scopedFree,
      minGpuFreeBytes: minBytes(devices.map((d) => d.freeBytes)),
      capacityVramBytes: scopedCapacity,
      minGpuCapacityBytes: minBytes(devices.map((d) => d.totalBytes)),
      gpuDeviceCount: tp,
      backend: req.backend ?? "cuda",
    });

    return { estimate, contextLength: ctx, modelMaxContext: modelMax };
  },
};
