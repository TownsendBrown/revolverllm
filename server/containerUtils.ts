import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import { promisify } from "util";
import { getDataDir, loadConfig } from "../electron/lib/config";
import { getGpuInfo } from "../electron/lib/gpu";
import type { EngineContainerSpec } from "../engines/types";
import { vulkanDriverEnv } from "../shared/gpuDevices";
import type { GpuDevice, ServerDefinition } from "../shared/types";

const execFileAsync = promisify(execFile);

/** Default per-call timeout. Container spawns (image pulls) override with a longer bound. */
const DOCKER_TIMEOUT_MS = 60_000;

export async function docker(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: opts?.timeoutMs ?? DOCKER_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
}

export async function dockerHealth(): Promise<{ available: boolean; error?: string }> {
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
    return { available: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = String(err.stderr || err.message || e).trim();
    const short = detail.split("\n").filter(Boolean).pop() || "Docker daemon not reachable";
    return { available: false, error: short };
  }
}

export async function dockerAvailable(): Promise<boolean> {
  return (await dockerHealth()).available;
}

export function containerName(serverId: string): string {
  return `revolver-server-${serverId}`;
}

function configDir(): string {
  return process.env.LLAMA_CONFIG_DIR ?? join(getDataDir(), "llama-config");
}

function decodeMountinfoField(field: string): string {
  return field.replace(/\\040/g, " ").replace(/\\011/g, "\t");
}

/**
 * Resolve the host-side source path for a mount point from /proc/self/mountinfo.
 * Works for compose named volumes (`.../volumes/<name>/_data`) and bind mounts.
 */
function configMountSourceFromMountinfo(mountPoint: string): string | null {
  const target = mountPoint.replace(/\/+$/, "") || "/";
  try {
    const lines = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
    let best: { root: string; mp: string } | null = null;
    for (const line of lines) {
      if (!line) continue;
      const sep = line.indexOf(" - ");
      if (sep < 0) continue;
      const fields = line.slice(0, sep).split(" ");
      if (fields.length < 5) continue;
      const root = decodeMountinfoField(fields[3] ?? "");
      const mp = decodeMountinfoField(fields[4] ?? "");
      if (mp !== target && !mp.startsWith(`${target}/`)) continue;
      if (!best || mp.length > best.mp.length) best = { root, mp };
    }
    if (!best?.root || best.root === "/") return null;
    return best.root;
  } catch {
    return null;
  }
}

/**
 * Mount source for the config dir on the host daemon.
 * - Mac Metal: explicit `LLAMA_CONFIG_HOST_DIR` bind mount (unchanged).
 * - Compose: derive the real host path from the backend's `/llama-config` mount so
 *   spawned containers share the same volume/bind source regardless of compose
 *   project name (avoids hard-coded `revolver_llama-config` mismatches).
 * - Electron: host `data/llama-config` directory.
 */
function configMountSource(): string {
  const hostDir = process.env.LLAMA_CONFIG_HOST_DIR;
  if (hostDir) return hostDir;
  if (process.env.REVOLVER_DOCKER === "1") {
    const mountPoint = configDir();
    const resolved = configMountSourceFromMountinfo(mountPoint);
    if (resolved) return resolved;
  }
  return process.env.LLAMA_CONFIG_VOLUME ?? configDir();
}

/** Host path for the models dir (compose backend sees /models, but the host daemon needs the real path). */
function hostModelsDir(): string {
  const raw = process.env.REVOLVER_HOST_MODELS_DIR ?? loadConfig().modelsDir;
  if (process.env.REVOLVER_DOCKER === "1" && !isAbsolute(raw)) {
    throw new Error(
      `REVOLVER_HOST_MODELS_DIR must be an absolute host path (got "${raw}"). Set MODELS_DIR in .env.`,
    );
  }
  return raw;
}

/** Write an engine entrypoint script into the shared config volume. */
export function ensureEntrypoint(fileName: string, script: string): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, script);
  try {
    chmodSync(path, 0o755);
  } catch {
    /* volume may not support chmod; sh /config/<entrypoint> is used as fallback */
  }
}

/**
 * `--gpus device=<host indices>` isolates the requested GPUs, but the runtime
 * renumbers them inside the container starting at 0. So *_VISIBLE_DEVICES inside
 * the container must reference relative indices (0..n-1), NOT the host indices —
 * otherwise a model pinned to e.g. host GPU 1 sees no usable device and silently
 * fails to offload.
 */
export function relativeVisibleDevices(def: ServerDefinition): string {
  return def.gpuDevices.map((_, i) => i).join(",");
}

function hostGroupGid(name: string): string | null {
  for (const path of ["/etc/group", "/host/etc/group"]) {
    try {
      const line = readFileSync(path, "utf8")
        .split("\n")
        .find((l) => l.startsWith(`${name}:`));
      const gid = line?.split(":")[2];
      if (gid) return gid;
    } catch {
      /* missing */
    }
  }
  return null;
}

/** GIDs that can open host DRM nodes. Names resolved from host or backend /etc/group. */
function driGroupArgs(): string[] {
  const gids = new Set<string>();
  for (const name of ["video", "render"]) {
    const gid = hostGroupGid(name);
    if (gid) gids.add(gid);
  }
  const addStat = (path: string) => {
    try {
      const gid = statSync(path).gid;
      if (gid > 0) gids.add(String(gid));
    } catch {
      /* backend container has no /dev/dri — host daemon still gets the bind mount */
    }
  };
  addStat("/dev/kfd");
  if (existsSync("/dev/dri")) {
    try {
      for (const name of readdirSync("/dev/dri")) addStat(join("/dev/dri", name));
    } catch {
      /* ignore */
    }
  }
  const args: string[] = [];
  for (const gid of gids) args.push("--group-add", gid);
  return args;
}

function rocmDockerArgs(hostDevices?: string): string[] {
  // Paths are host-daemon paths (docker.sock). Do not gate on existsSync inside
  // the compose backend — that filesystem has no /dev/dri.
  const args = [
    "-v",
    "/dev/dri:/dev/dri",
    "--device",
    "/dev/kfd",
    "--security-opt",
    "seccomp=unconfined",
    ...driGroupArgs(),
  ];
  if (hostDevices) {
    args.push("-e", `HIP_VISIBLE_DEVICES=${hostDevices}`, "-e", `ROCR_VISIBLE_DEVICES=${hostDevices}`);
  }
  return args;
}

/** Host DRM nodes (renderD* / card*). Compose backend has no /dev/dri; sysfs still lists them. */
function hostDriDeviceArgs(): string[] {
  const names = new Set<string>();
  const addFrom = (dir: string) => {
    try {
      for (const n of readdirSync(dir)) {
        if (/^(renderD|card)\d+$/.test(n)) names.add(n);
      }
    } catch {
      /* missing */
    }
  };
  addFrom("/dev/dri");
  const sys = (process.env.REVOLVER_SYSFS ?? "/sys").replace(/\/+$/, "");
  addFrom(join(sys, "class/drm"));
  const args: string[] = [];
  for (const n of [...names].sort()) {
    args.push("--device", `/dev/dri/${n}`);
  }
  return args;
}

/** DRM major 226 — a `/dev/dri` bind-mount is not in the default device cgroup. */
const DRM_CGROUP_RULE = "c 226:* rmw";

function vulkanDockerArgs(hostDevices?: string): string[] {
  const args = [
    ...hostDriDeviceArgs(),
    "-v",
    "/dev/dri:/dev/dri",
    "--device-cgroup-rule",
    DRM_CGROUP_RULE,
    "--security-opt",
    "seccomp=unconfined",
    ...driGroupArgs(),
  ];
  const indices = (hostDevices ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  let devices: GpuDevice[] = [];
  try {
    devices = getGpuInfo().devices;
  } catch {
    devices = [];
  }
  for (const [key, value] of Object.entries(vulkanDriverEnv(devices, indices))) {
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

/** Bump when GPU docker flags change so existing containers are recreated. */
export function gpuPassthroughSpec(def: ServerDefinition): string {
  switch (def.backend) {
    case "vulkan":
      return "vulkan-dri-device-v1";
    case "rocm":
      return "rocm-kfd-v1";
    case "cuda":
      return `cuda-${def.gpuDevices.join(",") || "all"}`;
    default:
      return "none";
  }
}

/** GPU device assignment per accelerator backend — independent of the inference engine. */
export function gpuRunArgs(def: ServerDefinition): string[] {
  if (def.backend === "cpu" || def.backend === "metal") return [];
  const hostDevices = def.gpuDevices.length ? def.gpuDevices.join(",") : undefined;
  const relative = def.gpuDevices.length ? relativeVisibleDevices(def) : undefined;
  switch (def.backend) {
    case "cuda":
      if (!hostDevices) {
        return process.env.LLAMA_GPU === "1" ? ["--gpus", "all"] : [];
      }
      // Quote the device list: Docker parses `--gpus` as CSV, so an unquoted
      // `device=0,1` is split into `device=0` + a bare `1` (read as Count),
      // triggering "cannot set both Count and DeviceIDs". The embedded quotes
      // keep `0,1` as a single field.
      return ["--gpus", `"device=${hostDevices}"`, "-e", `CUDA_VISIBLE_DEVICES=${relative}`];
    case "rocm":
      // ROCm sees every AMD GPU; HIP_VISIBLE_DEVICES must be the host HIP index,
      // not a 0..n-1 remap (there is no `--gpus` isolation).
      return rocmDockerArgs(hostDevices);
    case "vulkan":
      // Mesa image ICD list ≠ host vulkaninfo. vulkanDriverEnv remaps
      // GGML_VK_VISIBLE_DEVICES after pinning RADV/ANV.
      return vulkanDockerArgs(hostDevices);
    default:
      return [];
  }
}

export function llamaConnectHost(): string {
  return process.env.LLAMA_CONNECT_HOST ?? process.env.LLAMA_HOST ?? "127.0.0.1";
}

/**
 * Create and start an idle container for a server instance. The engine supplies
 * image/entrypoint/env/mounts via `spec`; this layer owns Docker lifecycle, GPU
 * device assignment, ports, volumes, networking, and labels.
 */
export async function ensureServerContainer(
  def: ServerDefinition,
  spec: EngineContainerSpec,
): Promise<void> {
  // Always refresh the entrypoint so restarts survive a wiped config volume
  // and pick up script updates without recreating the container.
  ensureEntrypoint(spec.entrypoint.fileName, spec.entrypoint.script);

  const name = containerName(def.id);
  try {
    const info = JSON.parse(await docker(["inspect", name]))[0] as {
      State?: { Status?: string };
      Config?: { Labels?: Record<string, string> };
    };
    const status = (info?.State?.Status ?? "").trim();
    const labels = info?.Config?.Labels ?? {};
    const stale = labels["revolver.gpu-passthrough"] !== gpuPassthroughSpec(def);
    if (stale) {
      await docker(["rm", "-f", name]);
    } else if (status === "running") {
      return;
    } else if (status === "exited" || status === "created") {
      await docker(["start", name]);
      return;
    }
  } catch {
    /* create below */
  }

  const cfg = loadConfig();
  const modelsSrc = hostModelsDir();
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--restart",
    "unless-stopped",
    // Labels let the boot reconciler discover/adopt/GC containers it owns.
    "--label",
    "revolver.managed=1",
    "--label",
    `revolver.server-id=${def.id}`,
    "--label",
    `revolver.server.id=${def.id}`,
    "--label",
    `revolver.engine=${def.engine ?? "llamacpp"}`,
    "--label",
    `revolver.model=${def.modelId}`,
    "--label",
    `revolver.gpu-passthrough=${gpuPassthroughSpec(def)}`,
    "--entrypoint",
    `/config/${spec.entrypoint.fileName}`,
    "-p",
    `${def.hostPort}:${spec.containerPort}`,
    "-v",
    `${configMountSource()}:/config`,
    "-v",
    `${modelsSrc}:${cfg.modelsDir}`,
  ];

  for (const [key, value] of Object.entries(spec.env)) {
    args.push("-e", `${key}=${value}`);
  }

  for (const mount of spec.extraMounts) {
    if (!existsSync(mount.source)) {
      mkdirSync(mount.source, { recursive: true });
    }
    args.push("-v", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`);
  }

  if (spec.shmSize) {
    args.push("--shm-size", spec.shmSize);
  }

  if (spec.ipcHost) {
    args.push("--ipc", "host");
  }

  if (process.env.REVOLVER_HOST_MODELS_DIR == null) {
    // Electron mode: hub/localRoot dirs may live outside modelsDir, mount them 1:1.
    if (cfg.hubModelsDir !== cfg.modelsDir) {
      args.push("-v", `${cfg.hubModelsDir}:${cfg.hubModelsDir}`);
    }
    if (cfg.localRoot && cfg.localRoot !== cfg.modelsDir) {
      args.push("-v", `${cfg.localRoot}:${cfg.localRoot}`);
    }
  }

  args.push(...gpuRunArgs(def));
  args.push(spec.image);
  // First run may pull a multi-GB backend image inline before returning.
  await docker(args, { timeoutMs: 600_000 });
}

/** Container status string (e.g. "running", "exited"); throws if it doesn't exist. */
export async function inspectContainerStatus(serverId: string): Promise<string> {
  return (
    await docker(["inspect", "-f", "{{.State.Status}}", containerName(serverId)])
  ).trim();
}

export async function removeServerContainer(serverId: string): Promise<void> {
  const name = containerName(serverId);
  try {
    await docker(["rm", "-f", name]);
  } catch {
    /* already gone */
  }
}

export async function restartServerContainer(serverId: string): Promise<void> {
  const name = containerName(serverId);
  try {
    const status = (await docker(["inspect", "-f", "{{.State.Status}}", name])).trim();
    if (status === "running") {
      await docker(["restart", name], { timeoutMs: 120_000 });
      return;
    }
    await docker(["start", name], { timeoutMs: 120_000 });
  } catch (e) {
    throw new Error(`Failed to restart container "${name}": ${e}`);
  }
}

export async function stopServerContainer(serverId: string): Promise<void> {
  try {
    await docker(["stop", containerName(serverId)]);
  } catch {
    /* may already be stopped */
  }
}

export async function fetchContainerLogs(
  serverId: string,
  opts?: { tail?: number; since?: string | null },
): Promise<string[]> {
  const tail = opts?.tail ?? 200;
  try {
    const args = ["logs", "--tail", String(tail)];
    // Docker retains logs across `restart`/`start`, so without `--since` a load
    // readiness check can match the previous run's "model loaded" line and report
    // success while the new model is still loading (or crashed).
    if (opts?.since) args.push("--since", opts.since);
    args.push(containerName(serverId));
    // Inference servers often write to stderr; entrypoint echoes use stdout. Merge
    // both so `docker logs` in a shell and Revolver's log panel show the same content.
    const { stdout, stderr } = await execFileAsync("docker", args, {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: DOCKER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const text = [stdout, stderr].filter(Boolean).join("\n");
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Container's current start time (RFC3339), used to ignore stale pre-restart logs. */
export async function getContainerStartedAt(serverId: string): Promise<string | null> {
  try {
    const out = (
      await docker(["inspect", "-f", "{{.State.StartedAt}}", containerName(serverId)])
    ).trim();
    return out && !out.startsWith("0001-01-01") ? out : null;
  } catch {
    return null;
  }
}

/**
 * Write the per-server env file the engine entrypoint sources on restart.
 * Values must already be container-mapped by the engine (this layer does no
 * engine-specific path translation).
 */
export function writeLoadEnv(
  fileName: string,
  lines: Record<string, string | number | null | undefined>,
): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(lines)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(join(dir, fileName), `${body}\n`);
}

export function clearLoadEnv(
  fileName: string,
  idle: Record<string, string | number | null | undefined> = { MODEL_PATH: "" },
): void {
  writeLoadEnv(fileName, idle);
}
