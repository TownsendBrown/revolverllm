import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import { promisify } from "util";
import { loadConfig } from "../electron/lib/config";
import { toContainerModelPath } from "../electron/lib/modelPaths";
import { getRevolverRoot } from "../electron/lib/appRoot";
import type { InferenceBackend, ServerDefinition } from "../shared/types";

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

export function containerName(serverId: string): string {
  return `revolver-server-${serverId}`;
}

export function envFileName(serverId: string): string {
  return `llama-load-${serverId}.env`;
}

/**
 * Public llama.cpp images per backend. We run these directly and inject our
 * own entrypoint via the shared config volume, so the backend container does
 * not need any Docker build context (which the host daemon couldn't see anyway).
 */
function backendImageTag(backend: InferenceBackend): string {
  const override = process.env[`LLAMA_IMAGE_${backend.toUpperCase()}`];
  if (override) return override;
  switch (backend) {
    case "cuda":
      return "ghcr.io/ggml-org/llama.cpp:server-cuda";
    case "rocm":
      return "ghcr.io/ggml-org/llama.cpp:server-rocm";
    case "vulkan":
      return "ghcr.io/ggml-org/llama.cpp:server-vulkan";
    default:
      return "ghcr.io/ggml-org/llama.cpp:server";
  }
}

/** Embedded so it works in both Electron and compose-backend modes without a build context. */
const ENTRYPOINT_SCRIPT = `#!/bin/sh
set -e

CONFIG_DIR="\${LLAMA_CONFIG_DIR:-/config}"
ENV_FILE="\${LLAMA_ENV_FILE:-llama-load.env}"
ENV_PATH="$CONFIG_DIR/$ENV_FILE"

HOST="0.0.0.0"
PORT="\${LLAMA_PORT:-8080}"
MODEL=""
CTX=""
GPU_LAYERS=""
MMPROJ=""
FLASH=""
CACHE_K=""
CACHE_V=""
N_PARALLEL=""
REASONING=""
KV_UNIFIED=""
API_KEY=""
BACKEND="\${BACKEND:-cpu}"

if [ -f "$ENV_PATH" ]; then
  # shellcheck disable=SC1090
  . "$ENV_PATH"
  MODEL="\${MODEL_PATH:-}"
  CTX="\${CTX_SIZE:-}"
  GPU_LAYERS="\${N_GPU_LAYERS:-}"
  MMPROJ="\${MMPROJ_PATH:-}"
  FLASH="\${FLASH_ATTN:-}"
  CACHE_K="\${CACHE_TYPE_K:-}"
  CACHE_V="\${CACHE_TYPE_V:-}"
  N_PARALLEL="\${N_PARALLEL:-}"
  REASONING="\${REASONING:-}"
  KV_UNIFIED="\${KV_UNIFIED:-}"
  API_KEY="\${API_KEY:-}"
  HOST="\${LLAMA_HOST:-0.0.0.0}"
  PORT="\${LLAMA_PORT:-8080}"
  BACKEND="\${BACKEND:-cpu}"
fi

[ -n "\${CUDA_VISIBLE_DEVICES:-}" ] && export CUDA_VISIBLE_DEVICES
[ -n "\${HIP_VISIBLE_DEVICES:-}" ] && export HIP_VISIBLE_DEVICES

case "$MODEL" in
  "" | undefined | null) MODEL="" ;;
esac

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  if [ -n "$MODEL" ]; then
    echo "llama-server: model file not found: $MODEL — idle (load via Revolver backend)"
  else
    echo "llama-server: no model configured — idle (load via Revolver backend)"
  fi
  exec sleep infinity
fi

set -- --host "$HOST" --port "$PORT" --model "$MODEL"
[ -n "$CTX" ] && set -- "$@" --ctx-size "$CTX"
[ -n "$GPU_LAYERS" ] && set -- "$@" --n-gpu-layers "$GPU_LAYERS"
[ -n "$MMPROJ" ] && set -- "$@" --mmproj "$MMPROJ"
[ -n "$FLASH" ] && set -- "$@" --flash-attn "$FLASH"
[ -n "$CACHE_K" ] && set -- "$@" --cache-type-k "$CACHE_K"
[ -n "$CACHE_V" ] && set -- "$@" --cache-type-v "$CACHE_V"
[ -n "$N_PARALLEL" ] && set -- "$@" --parallel "$N_PARALLEL"
[ -n "$REASONING" ] && set -- "$@" --reasoning "$REASONING"
[ -n "$API_KEY" ] && set -- "$@" --api-key "$API_KEY"
case "$KV_UNIFIED" in
  1 | on | true | yes) set -- "$@" --kv-unified ;;
esac

echo "llama-server starting: backend=$BACKEND model=$MODEL ctx=\${CTX:-default} gpu_layers=\${GPU_LAYERS:-0} flash_attn=\${FLASH:-default} kv=\${CACHE_K:-f16} parallel=\${N_PARALLEL:-auto} reasoning=\${REASONING:-auto} kv_unified=\${KV_UNIFIED:-default}"

LLAMA_BIN="\${LLAMA_SERVER_BIN:-}"
if [ -z "$LLAMA_BIN" ]; then
  for cand in /app/llama-server /llama-server "$(command -v llama-server 2>/dev/null)" "$(command -v llama-server-cuda 2>/dev/null)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then LLAMA_BIN="$cand"; break; fi
  done
fi
if [ -z "$LLAMA_BIN" ] || [ ! -x "$LLAMA_BIN" ]; then
  echo "llama-server binary not found (set LLAMA_SERVER_BIN)" >&2
  exit 127
fi
exec "$LLAMA_BIN" "$@"
`;

function configDir(): string {
  return process.env.LLAMA_CONFIG_DIR ?? join(getRevolverRoot(), "data", "llama-config");
}

/**
 * Mount source for the config dir on the host daemon. In compose the backend
 * writes to the `/llama-config` named volume, so spawned containers must mount
 * that same volume by name; in Electron it is a real host directory.
 */
function configMountSource(): string {
  return process.env.LLAMA_CONFIG_VOLUME ?? process.env.LLAMA_CONFIG_HOST_DIR ?? configDir();
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

function ensureEntrypoint(): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "entrypoint.sh");
  writeFileSync(path, ENTRYPOINT_SCRIPT);
  try {
    chmodSync(path, 0o755);
  } catch {
    /* volume may not support chmod; sh /config/entrypoint.sh is used as fallback */
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

function gpuRunArgs(def: ServerDefinition): string[] {
  if (def.backend === "cpu") return [];
  if (def.gpuDevices.length === 0) {
    if (def.backend === "cuda" && process.env.LLAMA_GPU === "1") {
      return ["--gpus", "all"];
    }
    return [];
  }
  const hostDevices = def.gpuDevices.join(",");
  const relative = relativeVisibleDevices(def);
  switch (def.backend) {
    case "cuda":
      // Quote the device list: Docker parses `--gpus` as CSV, so an unquoted
      // `device=0,1` is split into `device=0` + a bare `1` (read as Count),
      // triggering "cannot set both Count and DeviceIDs". The embedded quotes
      // keep `0,1` as a single field.
      return ["--gpus", `"device=${hostDevices}"`, "-e", `CUDA_VISIBLE_DEVICES=${relative}`];
    case "rocm":
      return [
        "--device",
        "/dev/kfd",
        "--device",
        "/dev/dri",
        "--security-opt",
        "seccomp=unconfined",
        "--group-add",
        "video",
        "-e",
        `HIP_VISIBLE_DEVICES=${relative}`,
        "-e",
        `ROCR_VISIBLE_DEVICES=${relative}`,
      ];
    case "vulkan":
      return ["--device", "/dev/dri"];
    default:
      return [];
  }
}

export function llamaConnectHost(): string {
  return process.env.LLAMA_CONNECT_HOST ?? process.env.LLAMA_HOST ?? "127.0.0.1";
}

/** Create and start idle container for a server instance. */
export async function ensureServerContainer(def: ServerDefinition): Promise<void> {
  const name = containerName(def.id);
  try {
    const status = (await docker(["inspect", "-f", "{{.State.Status}}", name])).trim();
    if (status === "running") return;
    if (status === "exited" || status === "created") {
      await docker(["start", name]);
      return;
    }
  } catch {
    /* create below */
  }

  ensureEntrypoint();

  const cfg = loadConfig();
  const image = backendImageTag(def.backend);
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
    "--entrypoint",
    "/config/entrypoint.sh",
    "-p",
    `${def.hostPort}:8080`,
    "-v",
    `${configMountSource()}:/config`,
    "-e",
    `LLAMA_CONFIG_DIR=/config`,
    "-e",
    `LLAMA_ENV_FILE=${envFileName(def.id)}`,
    "-e",
    `BACKEND=${def.backend}`,
    "-v",
    `${modelsSrc}:${cfg.modelsDir}`,
  ];

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
  args.push(image);
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
    // llama-server writes to stderr; entrypoint echoes use stdout. Merge both so
    // `docker logs` in a shell and Revolver's log panel show the same content.
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

export function writeLoadEnv(
  serverId: string,
  lines: Record<string, string | number | null | undefined>,
): void {
  ensureEntrypoint();
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const mapped = { ...lines };
  if (typeof mapped.MODEL_PATH === "string") {
    mapped.MODEL_PATH = toContainerModelPath(mapped.MODEL_PATH);
  }
  if (typeof mapped.MMPROJ_PATH === "string") {
    mapped.MMPROJ_PATH = toContainerModelPath(mapped.MMPROJ_PATH);
  }
  const body = Object.entries(mapped)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(join(dir, envFileName(serverId)), `${body}\n`);
}

export function clearLoadEnv(serverId: string): void {
  writeLoadEnv(serverId, { MODEL_PATH: "" });
}
