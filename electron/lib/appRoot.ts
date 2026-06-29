import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Project root (revolver/), not dist-electron/ */
export function getRevolverRoot(): string {
  if (process.env.REVOLVER_ROOT) return process.env.REVOLVER_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}
