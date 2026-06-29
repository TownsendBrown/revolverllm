/**
 * Local metadata sources (read-only): hub model.yaml, GGUF cache, user defaults.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { metaGet, metaNumber, metaString } from "./ggufMeta";
import { getHubModelsDir, getLocalPaths } from "./paths";

export interface GgufCacheEntry {
  arch: string;
  name: string;
  contextLength: number;
  embeddingLength: number;
  numAttentionHeads: number;
  numKeyValueHeads: number | null;
  numLayers: number;
  parameters: string;
  numExperts?: number | null;
  defaultNumExperts?: number | null;
}

export interface HubMeta {
  minMemoryBytes: number | null;
  contextLengths: number[];
}

export interface LoadDefaults {
  maxParallelPredictions: number;
  useUnifiedKvCache: boolean;
  offloadKVCacheToGpu: boolean;
}

/** Defaults aligned with typical llama-server load settings. */
export const LOAD_DEFAULTS: LoadDefaults = {
  maxParallelPredictions: 4,
  useUnifiedKvCache: true,
  offloadKVCacheToGpu: true,
};

function ggufCachePath(): string {
  return join(getLocalPaths().internal, "gguf-metadata-cache.json");
}

export function readGgufCacheEntry(modelPath: string): GgufCacheEntry | null {
  const cachePath = ggufCachePath();
  if (!existsSync(cachePath) || !existsSync(modelPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    const map: Array<[string, { mtimeMs: number; metadata: Record<string, unknown> }]> =
      raw.json?.map ?? raw.map ?? [];
    const hit = map.find(([p]) => p === modelPath);
    if (!hit) return null;
    const fileMtime = statSync(modelPath).mtimeMs;
    if (Math.abs(fileMtime - hit[1].mtimeMs) > 2000) return null;
    const m = hit[1].metadata;
    return {
      arch: String(m.arch ?? "unknown"),
      name: String(m.name ?? ""),
      contextLength: metaNumber(m.contextLength, 4096),
      embeddingLength: metaNumber(m.embeddingLength),
      numAttentionHeads: metaNumber(m.numAttentionHeads),
      numKeyValueHeads: m.numKeyValueHeads != null ? metaNumber(m.numKeyValueHeads) : null,
      numLayers: metaNumber(m.numLayers),
      parameters: String(m.parameters ?? ""),
      numExperts: m.numExperts != null ? metaNumber(m.numExperts) : null,
      defaultNumExperts: m.defaultNumExperts != null ? metaNumber(m.defaultNumExperts) : null,
    };
  } catch {
    return null;
  }
}

function parseHubYaml(yamlPath: string): HubMeta | null {
  try {
    const text = readFileSync(yamlPath, "utf8");
    const mo = extractYamlBlock(text, "metadataOverrides");
    if (!mo) return null;
    const ctx = mo.match(/contextLengths:\s*\n((?:\s+-\s+\d+\n?)+)/);
    const contextLengths = ctx
      ? [...ctx[1].matchAll(/-\s+(\d+)/g)].map((m) => Number(m[1]))
      : [];
    const minMatch = mo.match(/minMemoryUsageBytes:\s*(\d+)/);
    return {
      minMemoryBytes: minMatch ? Number(minMatch[1]) : null,
      contextLengths,
    };
  } catch {
    return null;
  }
}

function extractYamlBlock(text: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*\\n((?:  .+\\n)+)`, "m");
  return text.match(re)?.[1] ?? null;
}

export function readHubMeta(modelId: string): HubMeta | null {
  const [owner, name] = modelId.split("/");
  if (!owner || !name) return null;
  const direct = join(getHubModelsDir(), owner, name, "model.yaml");
  if (existsSync(direct)) return parseHubYaml(direct);

  const hubRoot = getHubModelsDir();
  if (!existsSync(hubRoot)) return null;
  for (const o of readdirSync(hubRoot, { withFileTypes: true })) {
    if (!o.isDirectory()) continue;
    for (const n of readdirSync(join(hubRoot, o.name), { withFileTypes: true })) {
      if (!n.isDirectory()) continue;
      const yamlPath = join(hubRoot, o.name, n.name, "model.yaml");
      if (!existsSync(yamlPath)) continue;
      const text = readFileSync(yamlPath, "utf8");
      if (text.includes(`model: ${modelId}`)) return parseHubYaml(yamlPath);
    }
  }
  return null;
}

/** Read GGUF fields the metadata cache omits (e.g. sliding_window). */
export async function readGgufExtras(modelPath: string): Promise<Record<string, unknown>> {
  const { gguf } = await import("@huggingface/gguf");
  const { metadata } = (await gguf(modelPath, { allowLocalFile: true })) as {
    metadata: Record<string, unknown>;
  };
  const arch = metaString(metadata["general.architecture"], "unknown");
  const pattern = metaGet(metadata, arch, "attention.sliding_window_pattern");
  const perLayerKv = metaGet(metadata, arch, "attention.head_count_kv");
  return {
    sliding_window: metaNumber(metaGet(metadata, arch, "attention.sliding_window")) || null,
    key_length: metaNumber(metaGet(metadata, arch, "attention.key_length")) || null,
    value_length: metaNumber(metaGet(metadata, arch, "attention.value_length")) || null,
    key_length_swa: metaNumber(metaGet(metadata, arch, "attention.key_length_swa")) || null,
    value_length_swa: metaNumber(metaGet(metadata, arch, "attention.value_length_swa")) || null,
    sliding_window_pattern: Array.isArray(pattern) ? pattern.map(Boolean) : null,
    head_count_kv_per_layer: Array.isArray(perLayerKv) ? perLayerKv.map(Number) : null,
  };
}

export function readUserModelContext(modelId: string): number | null {
  const path = join(getLocalPaths().internal, "user-concrete-model-default-config", `${modelId}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const field = raw.load?.fields?.find((f: { key: string }) => f.key === "llm.load.contextLength");
    return field?.value != null ? Number(field.value) : null;
  } catch {
    return null;
  }
}
