import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getRevolverRoot } from "./appRoot";
import type { ServerRuntimeMode } from "../../shared/types";

export function runtimeFromPackageJson(pkg: { revolverRuntime?: unknown }): ServerRuntimeMode | null {
  if (pkg.revolverRuntime === "native" || pkg.revolverRuntime === "docker") return pkg.revolverRuntime;
  return null;
}

/**
 * Packaged `npm run pack:native` writes `revolverRuntime` into the app package.json.
 * Env (`REVOLVER_RUNTIME`) always wins.
 */
export function applyPackagedRuntimeDefault(): void {
  const current = process.env.REVOLVER_RUNTIME;
  if (current === "native" || current === "docker") return;
  const pkgPath = join(getRevolverRoot(), "package.json");
  if (!existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { revolverRuntime?: unknown };
    const hint = runtimeFromPackageJson(pkg);
    if (hint) process.env.REVOLVER_RUNTIME = hint;
  } catch {
    /* ignore malformed package.json */
  }
}
