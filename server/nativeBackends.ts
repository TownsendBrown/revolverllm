import { accessSync, constants, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { getRevolverRoot } from "../electron/lib/appRoot";
import { platformLocalRoot } from "../electron/lib/config";
import {
  packBinaryRel,
  packLibRel,
  parseComputeCapList,
  pickBackendPack,
  type BackendCatalog,
  type BackendPackSpec,
} from "../shared/nativeBackends";

export interface InstalledBackendPack {
  spec: BackendPackSpec;
  root: string;
  bin: string;
  libDir: string;
}

export interface NativeBackendResolve {
  bin: string;
  libDir: string;
  packId: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function electronResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

export function loadBackendCatalog(catalogPath?: string): BackendCatalog | null {
  const resources = electronResourcesPath();
  const candidates = [
    catalogPath,
    process.env.REVOLVER_BACKEND_CATALOG,
    join(getRevolverRoot(), "backends", "catalog.json"),
    resources ? join(resources, "backends", "catalog.json") : undefined,
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as BackendCatalog;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function defaultPackSearchRoots(opts?: {
  repoRoot?: string;
  localRoot?: string;
  resourcesPath?: string;
  extra?: string[];
}): string[] {
  const roots: string[] = [];
  if (process.env.REVOLVER_BACKENDS_DIR) roots.push(process.env.REVOLVER_BACKENDS_DIR);
  for (const extra of opts?.extra ?? []) roots.push(extra);
  const resources = opts?.resourcesPath ?? electronResourcesPath();
  if (resources) roots.push(join(resources, "backends"));
  const repo = opts?.repoRoot ?? getRevolverRoot();
  roots.push(join(repo, "backends", "dist"));
  const local = opts?.localRoot ?? process.env.REVOLVER_LOCAL_ROOT ?? platformLocalRoot();
  roots.push(join(local, "backends"));
  const seen = new Set<string>();
  return roots.filter((r) => {
    if (!r || seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

export function readInstalledPack(dir: string, catalog?: BackendCatalog | null): InstalledBackendPack | null {
  const name = dir.split(/[/\\]/).pop() ?? "";
  const manPath = join(dir, "manifest.json");
  let spec: BackendPackSpec | undefined = catalog?.packs.find((p) => p.id === name);
  if (existsSync(manPath)) {
    try {
      const man = JSON.parse(readFileSync(manPath, "utf8")) as BackendPackSpec;
      spec = spec ? { ...spec, ...man } : man;
    } catch {
      /* ignore */
    }
  }
  if (!spec || spec.os === "darwin") return null;
  const bin = join(dir, packBinaryRel(spec));
  if (!existsSync(bin) || !isExecutable(bin)) return null;
  return {
    spec,
    root: dir,
    bin,
    libDir: join(dir, packLibRel(spec)),
  };
}

export function listInstalledPacks(
  roots: string[],
  catalog?: BackendCatalog | null,
): InstalledBackendPack[] {
  const out: InstalledBackendPack[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      const pack = readInstalledPack(dir, catalog);
      if (!pack) continue;
      if (seen.has(pack.bin)) continue;
      seen.add(pack.bin);
      out.push(pack);
    }
  }
  return out;
}

export function detectComputeCaps(): number[] {
  if (process.env.REVOLVER_COMPUTE_CAPS) {
    return parseComputeCapList(process.env.REVOLVER_COMPUTE_CAPS);
  }
  try {
    const result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=compute_cap", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 4000 },
    );
    if (result.status === 0 && result.stdout) {
      return parseComputeCapList(result.stdout.split(/\n+/));
    }
  } catch {
    /* no nvidia-smi */
  }
  return [];
}

export function resolveInstalledBackendPack(opts?: {
  catalog?: BackendCatalog | null;
  roots?: string[];
  computeCaps?: number[];
  platform?: NodeJS.Platform;
  forcePackId?: string;
}): NativeBackendResolve | null {
  if ((opts?.platform ?? process.platform) === "darwin") return null;
  const catalog = opts?.catalog ?? loadBackendCatalog();
  const installed = listInstalledPacks(opts?.roots ?? defaultPackSearchRoots(), catalog);
  if (!installed.length) return null;

  const force = opts?.forcePackId ?? process.env.REVOLVER_BACKEND_PACK;
  if (force) {
    const hit = installed.find((p) => p.spec.id === force);
    if (hit) return { bin: hit.bin, libDir: hit.libDir, packId: hit.spec.id };
  }

  const caps = opts?.computeCaps ?? detectComputeCaps();
  const spec = pickBackendPack(
    installed.map((p) => p.spec),
    { os: "linux", computeCaps: caps, forcePackId: force },
  );
  if (spec) {
    const hit = installed.find((p) => p.spec.id === spec.id);
    if (hit) return { bin: hit.bin, libDir: hit.libDir, packId: hit.spec.id };
  }
  if (installed.length === 1) {
    const only = installed[0];
    return { bin: only.bin, libDir: only.libDir, packId: only.spec.id };
  }
  return null;
}

export function mergeLibPath(env: NodeJS.ProcessEnv, libDir?: string | null): NodeJS.ProcessEnv {
  if (!libDir) return env;
  const prev = env.LD_LIBRARY_PATH ?? "";
  return {
    ...env,
    LD_LIBRARY_PATH: prev ? `${libDir}:${prev}` : libDir,
  };
}
