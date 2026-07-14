import { statSync } from "fs";
import { clampContextLength, modelMaxContext } from "../../electron/lib/contextLength";
import { readHubMeta } from "../../electron/lib/localMeta";
import {
  normalizeGgufMeta,
  readGgufMetadata,
  resolveModelPath,
} from "../../electron/lib/models";
import { loadRuntimeConfig } from "../../electron/lib/runtimeConfig";
import { estimateVram, effectiveGpuLayers } from "../../electron/lib/vram";
import type { MemoryEstimateRequest, MemoryEstimateResult, MemoryEstimator } from "../types";

function minBytes(values: number[]): number | null {
  return values.length ? Math.min(...values) : null;
}

/**
 * GGUF/llama.cpp estimator: model file size + GPU layer offload + KV cache,
 * with hub model.yaml hints when available. This is the pre-existing Revolver
 * estimation logic moved behind the MemoryEstimator interface.
 */
export const llamaMemoryEstimator: MemoryEstimator = {
  async estimate(req: MemoryEstimateRequest): Promise<MemoryEstimateResult> {
    const key = req.modelId ?? req.model.path;
    const { path, vision, minMemoryBytes, contextLengths } = resolveModelPath(key);
    const meta = normalizeGgufMeta(await readGgufMetadata(path));
    const hubMeta = req.modelId ? readHubMeta(req.modelId) : null;
    const yamlMin = hubMeta?.minMemoryBytes ?? minMemoryBytes;
    const yamlCtx = hubMeta?.contextLengths.length ? hubMeta.contextLengths : contextLengths;
    const modelMax =
      modelMaxContext(yamlCtx) ??
      (Number(meta.context_length ?? meta.contextLength ?? 0) || null);
    const ctx = clampContextLength(req.contextLength, modelMax);

    const devices = req.gpuDevices;
    const deviceCount = req.gpuDeviceCount ?? (devices.length || null);
    const scopedFree = devices.length ? devices.reduce((s, d) => s + d.freeBytes, 0) : null;
    const scopedCapacity = devices.length ? devices.reduce((s, d) => s + d.totalBytes, 0) : null;

    const estimate = estimateVram({
      modelFileBytes: statSync(path).size,
      ggufMeta: meta,
      contextLength: ctx,
      nGpuLayers: effectiveGpuLayers(req.backend, req.nGpuLayers),
      kvCacheDtype: req.kvCacheDtype ?? loadRuntimeConfig().kvCacheDtype,
      visionAdapterBytes: vision ? statSync(vision).size : 0,
      minMemoryHintBytes: yamlMin,
      availableVramBytes: scopedFree,
      minGpuFreeBytes: minBytes(devices.map((d) => d.freeBytes)),
      capacityVramBytes: scopedCapacity,
      minGpuCapacityBytes: minBytes(devices.map((d) => d.totalBytes)),
      gpuDeviceCount: deviceCount,
      backend: req.backend,
    });

    return { estimate, contextLength: ctx, modelMaxContext: modelMax };
  },
};
