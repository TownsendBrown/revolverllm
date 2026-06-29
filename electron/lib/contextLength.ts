export const DEFAULT_CONTEXT_LENGTH = 8192;
export const MAX_CONTEXT_LENGTH = 131072;

/** Clamp user context to sane bounds and optional model maximum. */
export function clampContextLength(ctx: number, modelMax?: number | null): number {
  let v = Math.max(512, Math.min(Math.floor(ctx), MAX_CONTEXT_LENGTH));
  if (modelMax != null && modelMax > 0) v = Math.min(v, modelMax);
  return v;
}

/** Default context when picking a model (prefer 8192 unless model max is lower). */
export function defaultContextForModel(modelMax?: number | null): number {
  if (modelMax == null || modelMax <= 0) return DEFAULT_CONTEXT_LENGTH;
  return Math.min(DEFAULT_CONTEXT_LENGTH, modelMax);
}

export function modelMaxContext(contextLengths: number[]): number | null {
  if (!contextLengths.length) return null;
  return Math.max(...contextLengths);
}
