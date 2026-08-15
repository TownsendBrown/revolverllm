/** Map Node fs errors to a message the renderer can show. */
export function toIpcError(e: unknown): Error {
  const err = e as NodeJS.ErrnoException;
  if (err && (err.code === "EACCES" || err.code === "EPERM")) {
    const path = err.path ? ` '${err.path}'` : "";
    return new Error(
      `Permission denied writing${path}. Use a user-owned data directory (or set REVOLVER_DATA_DIR).`,
    );
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}
