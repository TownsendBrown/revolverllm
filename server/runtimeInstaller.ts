import { createHash, randomUUID } from "crypto";
import { spawnSync } from "child_process";
import {
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  chmodSync,
  statfsSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { createRequire } from "node:module";
import { getRevolverRoot } from "../electron/lib/appRoot";
import { getDataDir } from "../electron/lib/config";
import { getGpuInfo } from "../electron/lib/gpu";
import { detectComputeCaps } from "./nativeBackends";
import {
  isLinuxRuntimeId,
  linuxRuntimeBackend,
  recommendedLinuxRuntimeId,
} from "../shared/nativeRuntimeMatch";
import {
  LINUX_RUNTIME_IDS,
  type InferenceBackend,
  type LinuxRuntimeId,
  type RuntimeCatalog,
  type RuntimeId,
  type RuntimeInstallJob,
  type RuntimeStatus,
} from "../shared/types";

const nodeRequire = createRequire(import.meta.url);

const jobs = new Map<string, RuntimeInstallJob>();
const abortControllers = new Map<string, AbortController>();
let activeJobId: string | null = null;

export interface LinuxCatalogAsset {
  label: string;
  backend: InferenceBackend;
  matchComputeCaps?: number[];
  tag: string;
  asset: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  unpackDir: string;
  binary?: string;
  libDir?: string;
}

export interface RuntimeCatalogFile {
  schemaVersion: number;
  llamacpp: {
    repo: string;
    tag: string;
    asset: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    unpackDir: string;
  };
  mlxRuntime: {
    version: string;
    asset: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    unpackDir: string;
    minMacos: string;
    mlxEngineCommit: string;
    pythonVersion: string;
  };
  linux?: Record<LinuxRuntimeId, LinuxCatalogAsset>;
}

function runtimesRoot(): string {
  const dir = join(getDataDir(), "runtimes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function jobsDir(): string {
  const dir = join(runtimesRoot(), "install-jobs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function persistJob(job: RuntimeInstallJob): void {
  writeFileSync(join(jobsDir(), `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}

function loadPersistedJobs(): void {
  jobsDir();
  for (const f of readdirSync(jobsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(jobsDir(), f), "utf8")) as RuntimeInstallJob;
      if (job.status === "running" || job.status === "queued") {
        job.status = "error";
        job.error = "Interrupted by restart";
      }
      jobs.set(job.id, job);
    } catch {
      /* skip */
    }
  }
}

loadPersistedJobs();

function updateJob(id: string, patch: Partial<RuntimeInstallJob>): RuntimeInstallJob {
  const cur = jobs.get(id);
  if (!cur) throw new Error("Runtime install job not found");
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(id, next);
  persistJob(next);
  return next;
}

function catalogPathCandidates(): string[] {
  const paths: string[] = [join(getRevolverRoot(), "runtimes", "catalog.json")];
  try {
    const electron = nodeRequire("electron") as typeof import("electron");
    if (electron.app?.isPackaged && process.resourcesPath) {
      paths.unshift(join(process.resourcesPath, "runtimes", "catalog.json"));
    }
  } catch {
    /* not in electron main */
  }
  return paths;
}

export function loadRuntimeCatalog(): RuntimeCatalogFile {
  const path = catalogPathCandidates().find((p) => existsSync(p));
  if (!path) throw new Error("Runtime catalog not found (runtimes/catalog.json)");
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeCatalogFile;
}

export function catalogForUi(): RuntimeCatalog {
  const c = loadRuntimeCatalog();
  const linux = LINUX_RUNTIME_IDS.map((id) => {
    const spec = c.linux?.[id];
    return {
      id,
      label: spec?.label ?? id,
      sizeBytes: spec?.sizeBytes ?? 0,
      tag: spec?.tag,
      backend: spec?.backend ?? linuxRuntimeBackend(id),
      matchComputeCaps: spec?.matchComputeCaps,
    };
  });
  return {
    llamacpp: {
      id: "llamacpp",
      label: "llama.cpp (Metal)",
      sizeBytes: c.llamacpp.sizeBytes,
      tag: c.llamacpp.tag,
    },
    mlx: {
      id: "mlx",
      label: "MLX (mlx-engine)",
      sizeBytes: c.mlxRuntime.sizeBytes,
      pythonVersion: c.mlxRuntime.pythonVersion,
      mlxEngineCommit: c.mlxRuntime.mlxEngineCommit.slice(0, 7),
      minMacos: c.mlxRuntime.minMacos,
    },
    linux,
  };
}

function readCurrentTag(kind: string): string | null {
  const marker = join(runtimesRoot(), kind, "current");
  if (!existsSync(marker)) return null;
  try {
    return readFileSync(marker, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function setCurrentTag(kind: string, tag: string): void {
  const base = join(runtimesRoot(), kind);
  mkdirSync(base, { recursive: true });
  const target = join(base, tag);
  if (!existsSync(target)) throw new Error(`Install dir missing: ${target}`);
  writeFileSync(join(base, "current"), `${tag}\n`);
}

/**
 * A tree left behind by an older build can have symlinks pointing into a
 * deleted staging dir. `llama-server` itself is a real file, so only the
 * dangling `@rpath` dylib links reveal the breakage — and they only surface as
 * a dyld failure at spawn time.
 */
export function hasDanglingSymlinks(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isSymbolicLink() && !existsSync(join(dir, e.name)));
}

export function installedLlamaCppDir(): string | null {
  const tag = readCurrentTag("llamacpp");
  if (!tag) return null;
  const dir = join(runtimesRoot(), "llamacpp", tag);
  if (!existsSync(join(dir, "llama-server"))) return null;
  if (hasDanglingSymlinks(dir)) return null;
  return dir;
}

export function installedLlamaServerBin(): string | null {
  const dir = installedLlamaCppDir();
  if (!dir) return null;
  const bin = join(dir, "llama-server");
  return existsSync(bin) ? bin : null;
}

export interface InstalledLinuxRuntime {
  id: LinuxRuntimeId;
  root: string;
  bin: string;
  libDir: string;
  tag: string;
}

function linuxAsset(id: LinuxRuntimeId): LinuxCatalogAsset | null {
  return loadRuntimeCatalog().linux?.[id] ?? null;
}

/** Locate llama-server in an extracted runtime tree (CUDA pack or ggml ubuntu layout). */
export function findLlamaServerBin(root: string, binaryRel?: string, depth = 0): string | null {
  const candidates = [
    binaryRel && depth === 0 ? join(root, binaryRel) : "",
    join(root, "llama-server"),
    join(root, "bin", "llama-server"),
    join(root, "build", "bin", "llama-server"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  if (depth >= 2) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const nested = findLlamaServerBin(join(root, e.name), undefined, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function libDirForBin(root: string, bin: string, libRel?: string): string {
  if (libRel) {
    const dir = join(root, libRel);
    if (existsSync(dir)) return dir;
  }
  const nextToBin = dirname(bin);
  const packLib = join(root, "lib");
  if (existsSync(packLib)) return packLib;
  return nextToBin;
}

export function installedLinuxRuntime(id: LinuxRuntimeId): InstalledLinuxRuntime | null {
  const tag = readCurrentTag(id);
  if (!tag) return null;
  const root = join(runtimesRoot(), id, tag);
  const spec = linuxAsset(id);
  const bin = findLlamaServerBin(root, spec?.binary);
  if (!bin) return null;
  if (hasDanglingSymlinks(dirname(bin))) return null;
  return { id, root, bin, libDir: libDirForBin(root, bin, spec?.libDir), tag };
}

export function listInstalledLinuxRuntimes(): InstalledLinuxRuntime[] {
  return LINUX_RUNTIME_IDS.map((id) => installedLinuxRuntime(id)).filter(
    (r): r is InstalledLinuxRuntime => r != null,
  );
}

export function resolveLinuxLlamaServer(opts?: {
  backend?: InferenceBackend;
  computeCaps?: number[];
  forceId?: LinuxRuntimeId;
}): InstalledLinuxRuntime | null {
  const installed = listInstalledLinuxRuntimes();
  if (!installed.length) return null;
  if (opts?.forceId) return installed.find((r) => r.id === opts.forceId) ?? null;

  const backend = opts?.backend;
  if (backend === "cuda") {
    return installed.find((r) => r.id === "linux-cuda") ?? null;
  }
  if (backend === "vulkan") {
    return installed.find((r) => r.id === "linux-vulkan") ?? null;
  }
  if (backend === "cpu") {
    return (
      installed.find((r) => r.id === "linux-cpu") ??
      installed[0] ??
      null
    );
  }
  const caps = opts?.computeCaps ?? detectComputeCaps();
  let gpu = null;
  try {
    gpu = getGpuInfo();
  } catch {
    gpu = null;
  }
  const rec = recommendedLinuxRuntimeId({ computeCaps: caps, gpu });
  return installed.find((r) => r.id === rec) ?? installed[0] ?? null;
}

export function installedMlxRuntimeDir(): string | null {
  const tag = readCurrentTag("mlx");
  if (!tag) return null;
  const dir = join(runtimesRoot(), "mlx", tag);
  if (!existsSync(join(dir, "python", "bin", "python3"))) return null;
  return dir;
}

export function installedMlxPython(): string | null {
  const dir = installedMlxRuntimeDir();
  if (!dir) return null;
  const py = join(dir, "python", "bin", "python3");
  return existsSync(py) ? py : null;
}

const MLX_IMPORT_PROBE =
  "import importlib.util; assert importlib.util.find_spec('mlx_engine'); assert importlib.util.find_spec('revolver_mlx_server'); assert importlib.util.find_spec('mlx')";

async function downloadUrl(opts: {
  url: string;
  destPath: string;
  expectedSha256?: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number | null) => void;
}): Promise<void> {
  const res = await fetch(opts.url, { signal: opts.signal, redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${opts.url}`);
  if (!res.body) throw new Error("Empty download body");

  mkdirSync(join(opts.destPath, ".."), { recursive: true });
  const total = Number(res.headers.get("content-length")) || null;
  const ws = createWriteStream(opts.destPath);
  const hash = createHash("sha256");
  let done = 0;

  const reader = res.body.getReader();
  while (true) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    hash.update(value);
    done += value.byteLength;
    opts.onProgress?.(done, total);
    await new Promise<void>((resolve, reject) => {
      ws.write(Buffer.from(value), (err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }
  await new Promise<void>((resolve, reject) =>
    ws.end((err: Error | null | undefined) => (err ? reject(err) : resolve())),
  );

  const digest = hash.digest("hex");
  if (opts.expectedSha256 && digest !== opts.expectedSha256.toLowerCase()) {
    rmSync(opts.destPath, { force: true });
    throw new Error(`Checksum mismatch (expected ${opts.expectedSha256}, got ${digest})`);
  }
}

function extractTarGz(archive: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xzf", archive, "-C", destDir, "--no-same-owner"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(r.stderr?.trim() || r.stdout?.trim() || "tar extract failed");
  }
}

/**
 * `cpSync` rewrites relative symlinks to absolute paths in the source tree
 * unless `verbatimSymlinks` is set. Both archives ship relative symlinks
 * (`python3 -> python3.11`, `libllama.dylib -> libllama.0.dylib`), so a plain
 * copy out of staging leaves links dangling the moment staging is deleted.
 * Move the tree instead; the copy fallback only matters across filesystems.
 */
export function moveIntoPlace(source: string, installDir: string): void {
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(join(installDir, ".."), { recursive: true });
  try {
    renameSync(source, installDir);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  cpSync(source, installDir, { recursive: true, verbatimSymlinks: true });
}

function freeBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Peak usage is the archive plus one extracted tree. Extraction expands roughly
 * 4x for the MLX runtime, and the tree is moved rather than copied into place.
 */
export function requiredInstallBytes(archiveBytes: number): number {
  return Math.round(archiveBytes * 5);
}

function ensureFreeSpace(dir: string, archiveBytes: number): void {
  const need = requiredInstallBytes(archiveBytes);
  const free = freeBytes(dir);
  if (free == null || free >= need) return;
  throw new Error(
    `Not enough free disk space: install needs about ${gib(need)}, only ${gib(free)} available. ` +
      `Free up space and try again.`,
  );
}

/** Drop a tree that failed verification, keeping any older working install selected. */
function clearInstall(kind: string, tag: string): void {
  rmSync(join(runtimesRoot(), kind, tag), { recursive: true, force: true });
  if (readCurrentTag(kind) === tag) {
    rmSync(join(runtimesRoot(), kind, "current"), { force: true });
  }
}

const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf]);

function isMachO(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACHO_MAGIC.has(head.readUInt32BE(0)) || MACHO_MAGIC.has(head.readUInt32LE(0));
  } catch {
    return false;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function machOFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isMachO(path)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/**
 * Ad-hoc sign each Mach-O in the tree. `codesign --deep` only accepts bundles,
 * and the archives extract to plain directories. Best effort: the runtimes ship
 * with toolchain ad-hoc signatures already, and the functional probe below is
 * the real gate, so a failure here must not abort the install.
 */
function adHocSignDir(dir: string): void {
  spawnSync("xattr", ["-cr", dir], { encoding: "utf8" });
  for (const file of machOFiles(dir)) {
    spawnSync("codesign", ["--force", "--sign", "-", file], { encoding: "utf8" });
  }
}

function probeMlxPython(python: string): boolean {
  const probe = spawnSync(python, ["-c", MLX_IMPORT_PROBE], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: join(python, "..", ".."),
  });
  return probe.status === 0;
}

async function installLlamaCpp(jobId: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") throw new Error("llama.cpp runtime install is macOS only");
  const cat = loadRuntimeCatalog();
  const staging = join(runtimesRoot(), ".staging", jobId);
  const archive = join(staging, cat.llamacpp.asset);
  mkdirSync(staging, { recursive: true });
  ensureFreeSpace(staging, cat.llamacpp.sizeBytes);

  updateJob(jobId, { phase: "download", progress: 0, bytesTotal: cat.llamacpp.sizeBytes });
  await downloadUrl({
    url: cat.llamacpp.url,
    destPath: archive,
    expectedSha256: cat.llamacpp.sha256,
    signal,
    onProgress: (bytes, total) => {
      updateJob(jobId, {
        bytesDone: bytes,
        bytesTotal: total ?? cat.llamacpp.sizeBytes,
        progress: total ? Math.min(40, Math.round((bytes / total) * 40)) : 10,
      });
    },
  });

  updateJob(jobId, { phase: "extract", progress: 45 });
  const extractRoot = join(staging, "extract");
  rmSync(extractRoot, { recursive: true, force: true });
  extractTarGz(archive, extractRoot);

  const unpacked = join(extractRoot, cat.llamacpp.unpackDir);
  if (!existsSync(unpacked)) {
    throw new Error(`Expected unpack dir ${cat.llamacpp.unpackDir} not found in archive`);
  }
  rmSync(archive, { force: true });

  const installDir = join(runtimesRoot(), "llamacpp", cat.llamacpp.tag);
  moveIntoPlace(unpacked, installDir);

  try {
    updateJob(jobId, { phase: "sign", progress: 70 });
    adHocSignDir(installDir);

    updateJob(jobId, { phase: "verify", progress: 85 });
    const bin = join(installDir, "llama-server");
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (probe.status !== 0) {
      throw new Error(
        probe.stderr?.trim() || probe.stdout?.trim() || "llama-server --version failed",
      );
    }
  } catch (e) {
    clearInstall("llamacpp", cat.llamacpp.tag);
    throw e;
  }

  setCurrentTag("llamacpp", cat.llamacpp.tag);
  rmSync(staging, { recursive: true, force: true });
  updateJob(jobId, {
    phase: "done",
    progress: 100,
    bytesDone: cat.llamacpp.sizeBytes,
    bytesTotal: cat.llamacpp.sizeBytes,
    installPath: installDir,
  });
}

async function installLinuxRuntime(
  jobId: string,
  runtimeId: LinuxRuntimeId,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform === "darwin") {
    throw new Error("Linux llama.cpp runtimes cannot be installed on macOS");
  }
  const spec = linuxAsset(runtimeId);
  if (!spec) throw new Error(`Linux runtime ${runtimeId} is missing from runtimes/catalog.json`);

  const staging = join(runtimesRoot(), ".staging", jobId);
  const archive = join(staging, spec.asset);
  mkdirSync(staging, { recursive: true });
  ensureFreeSpace(staging, spec.sizeBytes);

  updateJob(jobId, { phase: "download", progress: 0, bytesTotal: spec.sizeBytes });
  await downloadUrl({
    url: spec.url,
    destPath: archive,
    expectedSha256: spec.sha256,
    signal,
    onProgress: (bytes, total) => {
      updateJob(jobId, {
        bytesDone: bytes,
        bytesTotal: total ?? spec.sizeBytes,
        progress: total ? Math.min(40, Math.round((bytes / total) * 40)) : 10,
      });
    },
  });

  updateJob(jobId, { phase: "extract", progress: 45 });
  const extractRoot = join(staging, "extract");
  rmSync(extractRoot, { recursive: true, force: true });
  extractTarGz(archive, extractRoot);

  const unpacked =
    spec.unpackDir === "." ? extractRoot : join(extractRoot, spec.unpackDir);
  if (!existsSync(unpacked)) {
    throw new Error(`Expected unpack dir ${spec.unpackDir} not found in archive`);
  }
  rmSync(archive, { force: true });

  const installDir = join(runtimesRoot(), runtimeId, spec.tag);
  moveIntoPlace(unpacked, installDir);

  try {
    updateJob(jobId, { phase: "verify", progress: 85 });
    const bin = findLlamaServerBin(installDir, spec.binary);
    if (!bin) throw new Error("llama-server not found in extracted runtime");
    try {
      chmodSync(bin, 0o755);
    } catch {
      /* already executable */
    }
    const libDir = libDirForBin(installDir, bin, spec.libDir);
    const probe = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: libDir
          ? `${libDir}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ""}`
          : process.env.LD_LIBRARY_PATH,
      },
    });
    if (probe.status !== 0) {
      throw new Error(
        probe.stderr?.trim() || probe.stdout?.trim() || "llama-server --version failed",
      );
    }
  } catch (e) {
    clearInstall(runtimeId, spec.tag);
    throw e;
  }

  setCurrentTag(runtimeId, spec.tag);
  rmSync(staging, { recursive: true, force: true });
  updateJob(jobId, {
    phase: "done",
    progress: 100,
    bytesDone: spec.sizeBytes,
    bytesTotal: spec.sizeBytes,
    installPath: installDir,
  });
}

async function installMlx(jobId: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== "darwin") throw new Error("MLX runtime install is macOS only");
  const cat = loadRuntimeCatalog();
  const staging = join(runtimesRoot(), ".staging", jobId);
  mkdirSync(staging, { recursive: true });
  ensureFreeSpace(staging, cat.mlxRuntime.sizeBytes);

  const archive = join(staging, cat.mlxRuntime.asset);
  updateJob(jobId, { phase: "download", progress: 0, bytesTotal: cat.mlxRuntime.sizeBytes });
  await downloadUrl({
    url: cat.mlxRuntime.url,
    destPath: archive,
    expectedSha256: cat.mlxRuntime.sha256,
    signal,
    onProgress: (bytes, total) => {
      updateJob(jobId, {
        bytesDone: bytes,
        bytesTotal: total ?? cat.mlxRuntime.sizeBytes,
        progress: total ? Math.min(55, Math.round((bytes / total) * 55)) : 10,
      });
    },
  });

  updateJob(jobId, { phase: "extract", progress: 60 });
  const extractRoot = join(staging, "extract");
  rmSync(extractRoot, { recursive: true, force: true });
  extractTarGz(archive, extractRoot);

  const unpacked =
    cat.mlxRuntime.unpackDir === "." ? extractRoot : join(extractRoot, cat.mlxRuntime.unpackDir);
  if (!existsSync(unpacked)) {
    throw new Error(`Expected unpack dir ${cat.mlxRuntime.unpackDir} not found in archive`);
  }
  rmSync(archive, { force: true });

  const installDir = join(runtimesRoot(), "mlx", cat.mlxRuntime.version);
  moveIntoPlace(unpacked, installDir);

  try {
    const pythonBin = join(installDir, "python", "bin", "python3");
    if (!existsSync(pythonBin)) {
      throw new Error("MLX runtime archive missing python/bin/python3");
    }

    updateJob(jobId, { phase: "sign", progress: 85 });
    adHocSignDir(installDir);

    updateJob(jobId, { phase: "verify", progress: 92 });
    if (!probeMlxPython(pythonBin)) {
      throw new Error("mlx-engine import probe failed");
    }
  } catch (e) {
    clearInstall("mlx", cat.mlxRuntime.version);
    throw e;
  }

  setCurrentTag("mlx", cat.mlxRuntime.version);
  rmSync(staging, { recursive: true, force: true });
  updateJob(jobId, {
    phase: "done",
    progress: 100,
    bytesDone: cat.mlxRuntime.sizeBytes,
    bytesTotal: cat.mlxRuntime.sizeBytes,
    installPath: installDir,
  });
}

async function runJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  const ac = new AbortController();
  abortControllers.set(id, ac);
  updateJob(id, { status: "running", progress: 0, error: null });

  try {
    if (job.runtimeId === "llamacpp") await installLlamaCpp(id, ac.signal);
    else if (job.runtimeId === "mlx") await installMlx(id, ac.signal);
    else if (isLinuxRuntimeId(job.runtimeId)) await installLinuxRuntime(id, job.runtimeId, ac.signal);
    else throw new Error(`Unknown runtime: ${job.runtimeId}`);
    updateJob(id, { status: "done", progress: 100 });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      updateJob(id, { status: "cancelled", error: "cancelled" });
    } else {
      updateJob(id, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    abortControllers.delete(id);
    if (activeJobId === id) activeJobId = null;
    rmSync(join(runtimesRoot(), ".staging", id), { recursive: true, force: true });
  }
}

export function getRuntimesStatus(): RuntimeStatus {
  const cat = catalogForUi();
  const llamaBin = installedLlamaServerBin();
  const mlxPy = installedMlxPython();
  const mlxDir = installedMlxRuntimeDir();
  const mlxOk = mlxPy ? probeMlxPython(mlxPy) : false;
  const linux = LINUX_RUNTIME_IDS.map((id) => {
    const hit = installedLinuxRuntime(id);
    return {
      id,
      installed: Boolean(hit),
      path: hit?.bin ?? null,
      tag: hit?.tag ?? readCurrentTag(id),
      backend: linuxRuntimeBackend(id),
    };
  });
  let gpu = null;
  try {
    gpu = getGpuInfo();
  } catch {
    gpu = null;
  }
  const recommendedLinuxId =
    process.platform === "linux"
      ? recommendedLinuxRuntimeId({ computeCaps: detectComputeCaps(), gpu })
      : null;
  return {
    catalog: cat,
    llamacpp: {
      installed: Boolean(llamaBin),
      path: llamaBin,
      tag: readCurrentTag("llamacpp"),
    },
    mlx: {
      installed: mlxOk,
      python: mlxOk ? mlxPy : null,
      runtimePath: mlxOk ? mlxDir : null,
    },
    linux,
    recommendedLinuxId,
    platform: process.platform,
  };
}

export function listRuntimeInstallJobs(): RuntimeInstallJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRuntimeInstallJob(id: string): RuntimeInstallJob | null {
  return jobs.get(id) ?? null;
}

export async function startRuntimeInstall(runtimeId: RuntimeId): Promise<RuntimeInstallJob> {
  const linux = isLinuxRuntimeId(runtimeId);
  if (runtimeId === "mlx" && process.platform !== "darwin") {
    throw new Error("MLX runtime install is macOS only");
  }
  if (runtimeId === "llamacpp" && process.platform !== "darwin") {
    throw new Error("Metal llama.cpp runtime install is macOS only");
  }
  if (linux && process.platform === "darwin") {
    throw new Error("Linux llama.cpp runtimes cannot be installed on macOS");
  }
  if (runtimeId === "llamacpp" || runtimeId === "mlx") {
    if (process.platform !== "darwin") {
      throw new Error("Runtime install is supported on macOS only");
    }
  }
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active && (active.status === "running" || active.status === "queued")) {
      throw new Error("Another runtime install is already in progress");
    }
  }

  const cat = loadRuntimeCatalog();
  const bytesTotal = linux
    ? (cat.linux?.[runtimeId]?.sizeBytes ?? 0)
    : runtimeId === "llamacpp"
      ? cat.llamacpp.sizeBytes
      : cat.mlxRuntime.sizeBytes;

  const id = randomUUID();
  const job: RuntimeInstallJob = {
    id,
    runtimeId,
    status: "queued",
    phase: "queued",
    progress: 0,
    bytesDone: 0,
    bytesTotal,
    error: null,
    installPath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  persistJob(job);
  activeJobId = id;
  void runJob(id);
  return job;
}

export function cancelRuntimeInstallJob(id: string): RuntimeInstallJob {
  const job = jobs.get(id);
  if (!job) throw new Error("Runtime install job not found");
  abortControllers.get(id)?.abort();
  if (job.status === "queued" || job.status === "running") {
    return updateJob(id, { status: "cancelled", error: "cancelled" });
  }
  return job;
}
