import { statSync } from "fs";
import { metaGet, metaNumber, metaString } from "./ggufMeta";
import { readGgufCacheEntry } from "./localMeta";
import { normalizeModelPath, toFsPath } from "./modelPaths";

function parseHybridFields(metadata: Record<string, unknown>, arch: string) {
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

function buildFromGgufMetadata(
  fsPath: string,
  metadata: Record<string, unknown>,
  hybrid: ReturnType<typeof parseHybridFields>,
): Record<string, unknown> {
  const arch = metaString(
    metadata["general.architecture"] ?? metaGet(metadata, "general", "architecture"),
    "unknown",
  );
  const perLayerKv = hybrid.head_count_kv_per_layer;
  const scalarKv = metaGet(metadata, arch, "attention.head_count_kv");
  const numKeyValueHeads = Array.isArray(scalarKv)
    ? Math.max(...scalarKv.map(Number))
    : metaNumber(scalarKv) || null;

  return {
    arch,
    name: metaString(
      metadata["general.name"] ?? metaGet(metadata, "general", "name"),
      fsPath.split("/").pop() ?? "model",
    ),
    contextLength: metaNumber(metaGet(metadata, arch, "context_length"), 4096),
    embeddingLength: metaNumber(metaGet(metadata, arch, "embedding_length")),
    numAttentionHeads: metaNumber(metaGet(metadata, arch, "attention.head_count")),
    numKeyValueHeads,
    numLayers: metaNumber(metaGet(metadata, arch, "block_count")),
    keyLength: hybrid.key_length ?? (metaNumber(metaGet(metadata, arch, "attention.key_length")) || null),
    valueLength: hybrid.value_length ?? (metaNumber(metaGet(metadata, arch, "attention.value_length")) || null),
    slidingWindow: hybrid.sliding_window,
    keyLengthSwa: hybrid.key_length_swa,
    valueLengthSwa: hybrid.value_length_swa,
    slidingWindowPattern: hybrid.sliding_window_pattern,
    headCountKvPerLayer: perLayerKv,
    parameters: metaString(metadata["general.size_label"]),
    source: "gguf",
  };
}

const metaCache = new Map<string, { mtimeMs: number; meta: Record<string, unknown> }>();

/** Read GGUF metadata with a single file pass and mtime cache (large models are slow to re-parse). */
export async function readGgufMetadataCached(path: string): Promise<Record<string, unknown>> {
  const fsPath = normalizeModelPath(toFsPath(path));
  const mtimeMs = statSync(fsPath).mtimeMs;
  const hit = metaCache.get(fsPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.meta;

  const { gguf } = await import("@huggingface/gguf");
  const { metadata } = (await gguf(fsPath, { allowLocalFile: true })) as {
    metadata: Record<string, unknown>;
  };
  const arch = metaString(
    metadata["general.architecture"] ?? metaGet(metadata, "general", "architecture"),
    "unknown",
  );
  const hybrid = parseHybridFields(metadata, arch);
  const cached = readGgufCacheEntry(fsPath);

  const meta =
    cached && cached.numLayers > 0
      ? {
          arch: cached.arch,
          name: cached.name,
          contextLength: cached.contextLength,
          embeddingLength: cached.embeddingLength,
          numAttentionHeads: cached.numAttentionHeads,
          numKeyValueHeads: cached.numKeyValueHeads,
          numLayers: cached.numLayers,
          parameters: cached.parameters,
          keyLength: hybrid.key_length,
          valueLength: hybrid.value_length,
          slidingWindow: hybrid.sliding_window,
          keyLengthSwa: hybrid.key_length_swa,
          valueLengthSwa: hybrid.value_length_swa,
          slidingWindowPattern: hybrid.sliding_window_pattern,
          headCountKvPerLayer: hybrid.head_count_kv_per_layer,
          source: "metadata-cache",
        }
      : buildFromGgufMetadata(fsPath, metadata, hybrid);

  metaCache.set(fsPath, { mtimeMs, meta });
  return meta;
}
