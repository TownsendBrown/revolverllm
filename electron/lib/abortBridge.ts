/**
 * contextBridge structured-clones AbortSignal and drops EventTarget methods.
 * Calling addEventListener on the clone throws: "a.addEventListener is not a function".
 */
export function bindAbortSignal(
  signal:
    | {
        addEventListener?: unknown;
        removeEventListener?: unknown;
      }
    | null
    | undefined,
  onAbort: () => void,
): () => void {
  if (!signal || typeof signal.addEventListener !== "function") return () => {};
  const s = signal as AbortSignal;
  s.addEventListener("abort", onAbort);
  return () => {
    if (typeof s.removeEventListener === "function") {
      s.removeEventListener("abort", onAbort);
    }
  };
}
