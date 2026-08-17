/** Hub download file selection — weights plus tokenizer/config sidecars. */

export function isWeightFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".gguf") || lower.endsWith(".safetensors") || lower.endsWith(".bin");
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

const COMPANION_NAMES = new Set([
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "preprocessor_config.json",
  "processor_config.json",
  "chat_template.json",
  "chat_template.jinja",
]);

/** Config / tokenizer / template files MLX and transformers need beside weights. */
export function isCompanionFile(path: string): boolean {
  const base = basename(path);
  const lower = base.toLowerCase();
  if (lower.includes("mmproj") && lower.endsWith(".gguf")) return true;
  if (isWeightFile(lower)) return false;
  if (lower.endsWith(".jinja")) return true;
  if (lower.endsWith(".model") || lower.endsWith(".tiktoken")) return true;
  if (lower.endsWith(".index.json")) return true;
  if (COMPANION_NAMES.has(lower)) return true;
  if (lower.startsWith("tokenizer.")) return true;
  return false;
}

export function mergeWithCompanions(allPaths: string[], picked: string[]): string[] {
  const set = new Set(picked);
  for (const p of allPaths) {
    if (isCompanionFile(p)) set.add(p);
  }
  return allPaths.filter((p) => set.has(p));
}

/** Default Hub checkbox set: one GGUF quant (or all safetensors) plus sidecars. */
export function defaultHubPickedFiles(files: { path: string }[]): string[] {
  const paths = files.map((f) => f.path);
  const gguf = paths.filter((p) => {
    const lower = p.toLowerCase();
    return lower.endsWith(".gguf") && !lower.includes("mmproj");
  });
  if (gguf.length > 0) {
    const prefer =
      gguf.find((p) => /Q4_K_M/i.test(p)) ??
      gguf.find((p) => /Q5_K_M/i.test(p)) ??
      gguf.find((p) => /Q4_K_S/i.test(p)) ??
      gguf[0];
    return mergeWithCompanions(paths, prefer ? [prefer] : []);
  }
  const weights = paths.filter((p) => {
    const lower = p.toLowerCase();
    return lower.endsWith(".safetensors") || lower.endsWith(".bin");
  });
  return mergeWithCompanions(paths, weights);
}

export function mlxTokenizerPresent(names: string[]): boolean {
  const set = new Set(names.map((n) => n.toLowerCase()));
  if (set.has("tokenizer.json") || set.has("tokenizer.model")) return true;
  return set.has("vocab.json") && set.has("merges.txt");
}
