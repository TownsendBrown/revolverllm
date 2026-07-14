import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { readGgufCacheEntry } from "../../electron/lib/localMeta";
import { normalizeModelPath, toContainerModelPath } from "../../electron/lib/modelPaths";

/** GGUF `general.name` → HuggingFace tokenizer repo (vLLM cannot decode from GGUF vocab alone). */
const HF_TOKENIZER_BY_GGUF_NAME: Record<string, string> = {
  "mistralai_mistral-7b-instruct-v0.2": "mistralai/Mistral-7B-Instruct-v0.2",
  "mistralai_mistral-7b-instruct-v0.1": "mistralai/Mistral-7B-Instruct-v0.1",
  "mistralai_mistral-7b-v0.1": "mistralai/Mistral-7B-v0.1",
  meta_llama_llama_2_7b: "meta-llama/Llama-2-7b-hf",
  meta_llama_meta_llama_3_8b_instruct: "meta-llama/Meta-Llama-3-8B-Instruct",
};

const HF_TOKENIZER_BY_PATTERN: Array<{ pattern: RegExp; repo: string }> = [
  { pattern: /mistral-7b-instruct-v0\.2/i, repo: "mistralai/Mistral-7B-Instruct-v0.2" },
  { pattern: /mistral-7b-instruct-v0\.1/i, repo: "mistralai/Mistral-7B-Instruct-v0.1" },
  { pattern: /mistral-7b-v0\.1/i, repo: "mistralai/Mistral-7B-v0.1" },
  { pattern: /llama-2-7b/i, repo: "meta-llama/Llama-2-7b-hf" },
  { pattern: /llama-3.*8b/i, repo: "meta-llama/Meta-Llama-3-8B-Instruct" },
  { pattern: /qwen2.*7b/i, repo: "Qwen/Qwen2-7B-Instruct" },
  { pattern: /smollm2.*360m/i, repo: "HuggingFaceTB/SmolLM2-360M-Instruct" },
];

function generalNameToHfRepo(name: string): string | undefined {
  const mapped = HF_TOKENIZER_BY_GGUF_NAME[name];
  if (mapped) return mapped;

  const idx = name.indexOf("_");
  if (idx <= 0) return undefined;
  const org = name.slice(0, idx);
  const model = name.slice(idx + 1);
  if (!org || !model) return undefined;
  return `${org}/${model}`;
}

function hasMistralV3Tokenizer(dir: string): boolean {
  try {
    return readdirSync(dir).some(
      (f) => f === "tekken.json" || /^tokenizer\.model\.v\d+/.test(f) || /^tokenizer\.mm\.model\.v\d+/.test(f),
    );
  } catch {
    return false;
  }
}

function isLegacyMistralPath(path: string): boolean {
  return /mistral-7b|mistral-7b-instruct-v0|mistral-7b-v0/i.test(path);
}

function localTokenizerDir(modelPath: string): string | undefined {
  const abs = normalizeModelPath(modelPath);
  const dir = dirname(abs);
  // vLLM tokenizer-mode "mistral" needs tekken.json / tokenizer.model.v* — not HF tokenizer.model.
  if (isLegacyMistralPath(abs)) return undefined;
  if (hasMistralV3Tokenizer(dir)) return toContainerModelPath(dir);
  if (existsSync(join(dir, "tokenizer.json"))) return toContainerModelPath(dir);
  if (existsSync(join(dir, "tokenizer.model"))) return toContainerModelPath(dir);
  return undefined;
}

/** Resolve `--tokenizer` for vLLM GGUF loads (HF repo id or container path). */
export function resolveGgufTokenizer(modelPath: string): string | undefined {
  const abs = normalizeModelPath(modelPath);
  const local = localTokenizerDir(abs);
  if (local) return local;

  const cached = readGgufCacheEntry(abs);
  if (cached?.name) {
    const fromName = generalNameToHfRepo(cached.name) ?? HF_TOKENIZER_BY_GGUF_NAME[cached.name];
    if (fromName) return fromName;
  }

  const base = abs.split("/").pop()?.replace(/\.gguf$/i, "") ?? "";
  for (const { pattern, repo } of HF_TOKENIZER_BY_PATTERN) {
    if (pattern.test(base) || pattern.test(abs)) return repo;
  }

  return undefined;
}

export function ggufTokenizerRequiredMessage(modelPath: string): string {
  const base = modelPath.split("/").pop() ?? modelPath;
  return (
    `vLLM GGUF needs a HuggingFace tokenizer for ${base} — built-in GGUF vocab decodes to empty output. ` +
    "Use llama.cpp for GGUF, or place tokenizer.json beside the .gguf file."
  );
}

/** Tokenizer mode for vLLM. Legacy Mistral 7B uses HF sentencepiece (`slow`), not tekken (`mistral`). */
export function resolveVllmTokenizerMode(
  modelPath: string,
  opts?: { tokenizer?: string; modelId?: string },
): string | undefined {
  const haystack = [modelPath, opts?.tokenizer, opts?.modelId].filter(Boolean).join(" ").toLowerCase();
  if (!/mistral/.test(haystack)) return undefined;
  // Mistral 3+/Small use tekken tokenizer — v0.x GGUF needs legacy HF decode path.
  if (/mistral-small|mistral-large|mistral-nemo|ministral|mistral-3|tekken/i.test(haystack)) {
    return "mistral";
  }
  if (isLegacyMistralPath(haystack)) return "slow";
  return "slow";
}
