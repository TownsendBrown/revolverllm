import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { load as yamlLoad } from "js-yaml";
import { readGgufMetadataCached } from "./ggufMetadata";
import { metaGet, metaNumber, metaString } from "./ggufMeta";
import { getDownloadsDir, getHubModelsDir, getLocalPaths, getModelIndexCachePath } from "./paths";
import { normalizeModelPath, toFsPath } from "./modelPaths";
import type { CatalogModel, HubModel, LocalGgufModel, ModelFile } from "./types";

function parseModelYaml(text: string): Record<string, unknown> {
  try {
    return (yamlLoad(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function findMmproj(dir: string, exclude: string): string | null {
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (f.startsWith("mmproj") && f.endsWith(".gguf")) {
      const p = join(dir, f);
      if (p !== exclude) return p;
    }
  }
  return null;
}

export { toFsPath, normalizeModelPath, toContainerModelPath } from "./modelPaths";

export async function readGgufMetadata(path: string): Promise<Record<string, unknown>> {
  return readGgufMetadataCached(path);
}

function normalizeMeta(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    arch: raw.arch,
    name: raw.name,
    context_length: raw.contextLength ?? raw.context_length,
    embedding_length: raw.embeddingLength ?? raw.embedding_length,
    num_attention_heads: raw.numAttentionHeads ?? raw.num_attention_heads,
    num_key_value_heads: raw.numKeyValueHeads ?? raw.num_key_value_heads,
    num_layers: raw.numLayers ?? raw.num_layers,
    key_length: raw.keyLength ?? raw.key_length,
    value_length: raw.valueLength ?? raw.value_length,
    sliding_window: raw.slidingWindow ?? raw.sliding_window,
    key_length_swa: raw.keyLengthSwa ?? raw.key_length_swa ?? null,
    value_length_swa: raw.valueLengthSwa ?? raw.value_length_swa ?? null,
    sliding_window_pattern: raw.slidingWindowPattern ?? raw.sliding_window_pattern ?? null,
    head_count_kv_per_layer: raw.headCountKvPerLayer ?? raw.head_count_kv_per_layer ?? null,
    parameters: raw.parameters,
    source: raw.source,
  };
}

function fileInfo(path: string, root: string, role: ModelFile["role"]): ModelFile {
  return {
    path,
    relPath: relative(root, path),
    sizeBytes: statSync(path).size,
    role,
  };
}

export function scanHubModels(): HubModel[] {
  const hubRoot = getHubModelsDir();
  if (!existsSync(hubRoot)) return [];

  const results: HubModel[] = [];
  for (const owner of readdirSync(hubRoot, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const modelDir of readdirSync(join(hubRoot, owner.name), { withFileTypes: true })) {
      if (!modelDir.isDirectory()) continue;
      const hubPath = join(hubRoot, owner.name, modelDir.name);
      const manifestPath = join(hubPath, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      let modelYaml: Record<string, unknown> = {};
      const yamlPath = join(hubPath, "model.yaml");
      if (existsSync(yamlPath)) {
        modelYaml = parseModelYaml(readFileSync(yamlPath, "utf8"));
      }

      const mo = (modelYaml.metadataOverrides ?? {}) as Record<string, unknown>;
      const paramsList = (mo.paramsStrings as string[]) ?? [];
      const modelKey = String(modelYaml.model ?? `${owner.name}/${modelDir.name}`);

      results.push({
        id: `${owner.name}/${modelDir.name}`,
        owner: owner.name,
        name: modelDir.name,
        displayName: modelDir.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        hubPath,
        domain: String(mo.domain ?? "llm"),
        architectures: (mo.architectures as string[]) ?? [],
        params: paramsList[0] ?? "",
        minMemoryBytes: (mo.minMemoryUsageBytes as number) ?? null,
        contextLengths: (mo.contextLengths as number[]) ?? [],
        entryPoint: null,
        visionAdapter: null,
        hasWeights: false,
        loaded: false,
        revision: manifest.revision,
      });
    }
  }
  return results;
}

export function scanLocalGguf(): LocalGgufModel[] {
  const root = getDownloadsDir();
  if (!existsSync(root)) return [];

  const models: LocalGgufModel[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".gguf") && !ent.name.startsWith("mmproj")) {
        const mm = findMmproj(join(p, ".."), p);
        models.push({
          id: relative(root, p),
          path: p,
          relPath: relative(root, p),
          sizeBytes: statSync(p).size,
          metadata: { name: ent.name.replace(/\.gguf$/, "") },
          visionPath: mm,
          visionSizeBytes: mm ? statSync(mm).size : 0,
        });
      }
    }
  };
  walk(root);
  return models;
}

export function linkHubToLocal(hub: HubModel[], local: LocalGgufModel[]): void {
  const byRepo = new Map<string, LocalGgufModel>();
  for (const m of local) {
    const parts = m.relPath.split("/");
    if (parts.length >= 2) {
      byRepo.set(parts[1].toLowerCase(), m);
      byRepo.set(`${parts[0]}/${parts[1]}`.toLowerCase(), m);
    }
  }

  const downloadsRoot = getDownloadsDir();
  for (const h of hub) {
    const manifestText = readFileSync(join(h.hubPath, "manifest.json"), "utf8").toLowerCase();
    let best: LocalGgufModel | null = null;
    let bestScore = 0;
    for (const [key, loc] of byRepo) {
      if (manifestText.includes(key)) {
        if (key.length > bestScore) {
          best = loc;
          bestScore = key.length;
        }
      }
    }
    if (best) {
      h.entryPoint = fileInfo(best.path, downloadsRoot, "entry");
      h.hasWeights = true;
      if (best.visionPath) {
        h.visionAdapter = fileInfo(best.visionPath, downloadsRoot, "vision");
      }
    }
  }
}

/** Use model-index-cache when available for richer display names */
export function enrichFromIndexCache(hub: HubModel[]): void {
  const cachePath = getModelIndexCachePath();
  if (!existsSync(cachePath)) return;
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const models = cache.models as Array<{ containingDirSubpath?: string; displayName?: string }>;
    if (!Array.isArray(models)) return;
    const byPath = new Map(models.map((m) => [m.containingDirSubpath, m]));
    for (const h of hub) {
      const sub = `${h.owner}/${h.name}`;
      const hit = byPath.get(sub);
      if (hit?.displayName) h.displayName = hit.displayName;
    }
  } catch {
    /* optional cache */
  }
}

export function buildCatalog(loadedModelIds: string | string[] | null): CatalogModel[] {
  const loaded = new Set(
    loadedModelIds == null ? [] : Array.isArray(loadedModelIds) ? loadedModelIds : [loadedModelIds],
  );
  const isLoaded = (id: string, path: string | null) =>
    loaded.has(id) || (path != null && loaded.has(path));
  const hub = scanHubModels();
  const local = scanLocalGguf();
  linkHubToLocal(hub, local);
  enrichFromIndexCache(hub);

  const linkedPaths = new Set<string>();
  const models: CatalogModel[] = [];

  for (const h of hub) {
    const path = h.entryPoint?.path ?? null;
    if (path) linkedPaths.add(path);
    models.push({
      id: h.id,
      displayName: h.displayName,
      subtitle: h.id,
      path,
      sizeBytes: h.entryPoint?.sizeBytes ?? null,
      source: "hub",
      params: h.params,
      hasWeights: h.hasWeights,
      contextLengths: h.contextLengths,
      minMemoryBytes: h.minMemoryBytes,
      loaded: isLoaded(h.id, path),
    });
  }

  for (const loc of local) {
    if (linkedPaths.has(loc.path)) continue;
    models.push({
      id: loc.path,
      displayName: loc.relPath.split("/").pop() ?? loc.id,
      subtitle: loc.relPath,
      path: loc.path,
      sizeBytes: loc.sizeBytes,
      source: "file",
      params: "",
      hasWeights: true,
      contextLengths: [],
      minMemoryBytes: null,
      loaded: isLoaded(loc.path, loc.path),
    });
  }

  models.sort((a, b) => {
    if (a.hasWeights !== b.hasWeights) return a.hasWeights ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  return models;
}

export function getCatalog(loadedModelIds: string | string[] | null) {
  const paths = getLocalPaths();
  return {
    models: buildCatalog(loadedModelIds),
    paths: { hub: paths.hubModels, downloads: getDownloadsDir(), root: paths.root },
  };
}

export function normalizeGgufMeta(raw: Record<string, unknown>): Record<string, unknown> {
  return normalizeMeta(raw);
}

export interface ResolvedModel {
  modelId: string;
  path: string;
  vision: string | null;
  minMemoryBytes: number | null;
  contextLengths: number[];
}

export function resolveModelPath(modelIdOrPath: string): ResolvedModel {
  if (modelIdOrPath.endsWith(".gguf") || modelIdOrPath.startsWith("/")) {
    const path = normalizeModelPath(toFsPath(modelIdOrPath));
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    const mm = findMmproj(join(path, ".."), path);
    return {
      modelId: path,
      path,
      vision: mm ? normalizeModelPath(mm) : null,
      minMemoryBytes: null,
      contextLengths: [],
    };
  }
  const hub = scanHubModels();
  const local = scanLocalGguf();
  linkHubToLocal(hub, local);
  const h = hub.find((m) => m.id === modelIdOrPath);
  if (h?.entryPoint) {
    return {
      modelId: h.id,
      path: normalizeModelPath(toFsPath(h.entryPoint.path)),
      vision: h.visionAdapter?.path ? normalizeModelPath(toFsPath(h.visionAdapter.path)) : null,
      minMemoryBytes: h.minMemoryBytes,
      contextLengths: h.contextLengths,
    };
  }
  const loc = local.find((m) => m.id === modelIdOrPath || m.path === modelIdOrPath);
  if (loc) {
    return {
      modelId: loc.path,
      path: normalizeModelPath(loc.path),
      vision: loc.visionPath ? normalizeModelPath(loc.visionPath) : null,
      minMemoryBytes: null,
      contextLengths: [],
    };
  }
  throw new Error(`Model not found: ${modelIdOrPath}`);
}
