import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import type { ModelFormat, ModelSource } from "../../shared/types";
import { getDownloadsDir, getHubModelsDir } from "./paths";

export interface LocalHfModel {
  id: string;
  path: string;
  relPath: string;
  sizeBytes: number;
  format: ModelFormat;
  source: ModelSource;
  architectures: string[];
  contextLength: number | null;
  metadata: Record<string, unknown>;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

function detectFormat(dir: string, config: Record<string, unknown>): ModelFormat {
  const quant = config.quantization_config as Record<string, unknown> | undefined;
  const method = String(quant?.quant_method ?? quant?.bits ?? "").toLowerCase();
  if (method.includes("awq") || dir.toLowerCase().includes("awq")) return "awq";
  if (method.includes("gptq") || dir.toLowerCase().includes("gptq")) return "gptq";

  const mlxQuant = config.quantization as Record<string, unknown> | undefined;
  if (mlxQuant && typeof mlxQuant === "object" && (mlxQuant.bits != null || mlxQuant.group_size != null)) {
    return "mlx";
  }
  if (dir.toLowerCase().includes("mlx") || /[-_]mlx[-_]/i.test(dir)) return "mlx";

  const files = readdirSync(dir);
  if (files.some((f) => f.endsWith(".gguf"))) return "gguf";
  if (files.some((f) => f.endsWith(".safetensors"))) return "safetensors";
  if (files.some((f) => f.endsWith(".bin"))) return "safetensors";
  return "safetensors";
}

function parseConfig(dir: string): Record<string, unknown> | null {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isModelDir(dir: string): boolean {
  return parseConfig(dir) != null;
}

function walkModelDirs(root: string, relPrefix: string, out: LocalHfModel[]): void {
  if (!existsSync(root)) return;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    if (isModelDir(dir)) {
      const config = parseConfig(dir)!;
      const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const parts = relPath.split("/");
      const id = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : relPath;
      const maxPos = Number(
        (config.max_position_embeddings as number | undefined) ??
          (config.model_max_length as number | undefined) ??
          0,
      );
      out.push({
        id,
        path: dir,
        relPath,
        sizeBytes: dirSizeBytes(dir),
        format: detectFormat(dir, config),
        source: "local",
        architectures: Array.isArray(config.architectures)
          ? (config.architectures as string[])
          : config.model_type
            ? [String(config.model_type)]
            : [],
        contextLength: maxPos > 0 ? maxPos : null,
        metadata: config,
      });
      continue;
    }
    walkModelDirs(dir, relPrefix ? `${relPrefix}/${ent.name}` : ent.name, out);
  }
}

/** Scan local HuggingFace-style model directories (config.json + weights). */
export function scanLocalHfModels(): LocalHfModel[] {
  const results: LocalHfModel[] = [];
  const roots = [
    { root: getDownloadsDir(), prefix: "" },
    { root: getHubModelsDir(), prefix: "" },
  ];
  for (const { root, prefix } of roots) {
    if (!existsSync(root)) continue;
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const ownerDir = join(root, ent.name);
      for (const modelEnt of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!modelEnt.isDirectory()) continue;
        const modelDir = join(ownerDir, modelEnt.name);
        if (!isModelDir(modelDir)) continue;
        const config = parseConfig(modelDir)!;
        const relPath = prefix
          ? `${prefix}/${ent.name}/${modelEnt.name}`
          : `${ent.name}/${modelEnt.name}`;
        const maxPos = Number(
          (config.max_position_embeddings as number | undefined) ??
            (config.model_max_length as number | undefined) ??
            0,
        );
        results.push({
          id: `${ent.name}/${modelEnt.name}`,
          path: modelDir,
          relPath,
          sizeBytes: dirSizeBytes(modelDir),
          format: detectFormat(modelDir, config),
          source: "local",
          architectures: Array.isArray(config.architectures)
            ? (config.architectures as string[])
            : config.model_type
              ? [String(config.model_type)]
              : [],
          contextLength: maxPos > 0 ? maxPos : null,
          metadata: config,
        });
      }
      walkModelDirs(ownerDir, prefix ? `${prefix}/${ent.name}` : ent.name, results);
    }
  }

  const seen = new Set<string>();
  return results.filter((m) => {
    if (seen.has(m.path)) return false;
    seen.add(m.path);
    return true;
  });
}

/** True when the string looks like a HuggingFace repo id (owner/name). */
export function isHfRepoId(value: string): boolean {
  if (isAbsolute(value)) return false;
  if (value.includes("/") && !value.startsWith("/") && !value.endsWith(".gguf")) {
    const parts = value.split("/");
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0 && !parts[0].includes(".");
  }
  return false;
}

export function readHfConfig(modelPath: string): Record<string, unknown> | null {
  return parseConfig(modelPath);
}

/** Classify a local filesystem path as GGUF file or HuggingFace model directory. */
export function classifyLocalModelPath(absPath: string): {
  id: string;
  format: ModelFormat;
  path: string;
} | null {
  if (!existsSync(absPath)) return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return null;
  }

  if (st.isFile()) {
    if (!absPath.endsWith(".gguf")) return null;
    return { id: absPath, format: "gguf", path: absPath };
  }

  if (!st.isDirectory()) return null;

  const hit = scanLocalHfModels().find((m) => m.path === absPath);
  if (hit) return { id: hit.id, format: hit.format, path: hit.path };

  const config = parseConfig(absPath);
  if (!config) return null;

  const parts = absPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? absPath;
  const owner = parts[parts.length - 2];
  const id = owner ? `${owner}/${name}` : name;

  return { id, format: detectFormat(absPath, config), path: absPath };
}
