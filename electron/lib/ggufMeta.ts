/** Read architecture-scoped fields from @huggingface/gguf flat or nested metadata. */
export function metaGet(
  metadata: Record<string, unknown>,
  arch: string,
  path: string,
): unknown {
  const flat = `${arch}.${path}`;
  if (metadata[flat] != null) return metadata[flat];

  const nested = metadata[arch];
  if (nested == null || typeof nested !== "object") return undefined;

  let cur: unknown = nested;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function metaNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function metaString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}
