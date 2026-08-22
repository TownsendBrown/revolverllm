import { spawn, execFile, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { promisify } from "util";
import { getDataDir } from "../electron/lib/config";
import { resolveLlamaServerBin } from "./llamaServerBin";
import { probeMlxRuntime } from "./mlxServerBin";
import { mergeLibPath } from "./nativeBackends";
import {
  LLAMA_ENTRYPOINT_FILE,
  LLAMA_ENTRYPOINT_SCRIPT,
  llamaEnvFileName,
} from "../engines/llamacpp/docker";
import { buildLlamaServerArgs, llamaStartLogLine } from "../engines/llamacpp/nativeArgs";
import { mlxEnvFileName } from "../engines/mlx/docker";
import { mlxTokenizerPresent } from "../shared/hubDownloadFiles";
import { parseLoadEnv } from "../shared/loadEnvFile";
import type { InferenceBackend } from "../shared/types";

const execFileAsync = promisify(execFile);

export interface NativeSupervisorOptions {
  configDir: string;
  llamaServerBin?: string;
  extraEnv?: Record<string, string>;
}

export interface NativeServerInspect {
  serverId: string;
  hostPort: number;
  status: "idle" | "starting" | "running" | "stopped" | "crashed";
  pid: number | null;
  startedAt: string | null;
}

interface ServerRecord {
  serverId: string;
  hostPort: number;
  proc: ChildProcess | null;
  status: NativeServerInspect["status"];
  pid: number | null;
  startedAt: string | null;
  logBuffer: string[];
}

const MAX_LOG_LINES = 4000;

function appendLog(rec: ServerRecord, line: string): void {
  rec.logBuffer.push(line);
  if (rec.logBuffer.length > MAX_LOG_LINES) {
    rec.logBuffer.splice(0, rec.logBuffer.length - MAX_LOG_LINES);
  }
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseLoadEnv(readFileSync(path, "utf8"));
}

function parsePids(text: string): number[] {
  return text
    .trim()
    .split(/[\s,]+/)
    .map((p) => Number(p))
    .filter((p) => p > 0 && Number.isFinite(p));
}

async function findListenerPids(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ano"], { timeout: 5000 });
      const pids = new Set<number>();
      const needle = `:${port}`;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes(needle) || !/\sLISTENING\s/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid > 0) pids.add(pid);
      }
      return [...pids];
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`], { timeout: 5000 });
    return parsePids(stdout);
  } catch {
    /* try fuser */
  }
  try {
    const { stdout, stderr } = await execFileAsync("fuser", [`${port}/tcp`], { timeout: 5000 });
    return parsePids(`${stdout}\n${stderr}`);
  } catch {
    return [];
  }
}

async function freeHostPort(port: number): Promise<void> {
  const pids = (await findListenerPids(port)).filter((p) => p !== process.pid);
  if (!pids.length) return;
  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      /* gone */
    }
  }
  await new Promise((r) => setTimeout(r, 400));
  if (process.platform === "win32") return;
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function pipeOutput(rec: ServerRecord, stream: NodeJS.ReadableStream): void {
  let partial = "";
  stream.on("data", (chunk: Buffer) => {
    partial += chunk.toString();
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length) appendLog(rec, line);
    }
  });
}

export class NativeSupervisor {
  private servers = new Map<string, ServerRecord>();

  constructor(private opts: NativeSupervisorOptions) {
    mkdirSync(opts.configDir, { recursive: true });
  }

  ensure(serverId: string, hostPort: number): NativeServerInspect {
    let rec = this.servers.get(serverId);
    if (!rec) {
      rec = {
        serverId,
        hostPort,
        proc: null,
        status: "idle",
        pid: null,
        startedAt: null,
        logBuffer: [],
      };
      this.servers.set(serverId, rec);
    } else {
      rec.hostPort = hostPort;
    }
    return this.toInspect(rec);
  }

  async restart(serverId: string, hostPort: number): Promise<NativeServerInspect> {
    const rec = this.ensureRecord(serverId, hostPort);
    await this.stopProcess(rec);
    await freeHostPort(hostPort);
    rec.logBuffer = [];
    rec.status = "starting";
    rec.startedAt = new Date().toISOString();

    const mlxEnvPath = join(this.opts.configDir, mlxEnvFileName(serverId));
    const llamaEnvPath = join(this.opts.configDir, llamaEnvFileName(serverId));
    const isMlx = existsSync(mlxEnvPath);
    const fileEnv = parseEnvFile(isMlx ? mlxEnvPath : llamaEnvPath);
    const model = fileEnv.MODEL ?? fileEnv.MODEL_PATH ?? "";
    if (!model) {
      rec.status = "idle";
      appendLog(
        rec,
        `${isMlx ? "revolver_mlx_server" : "llama-server"}: no model configured — idle (load via manager)`,
      );
      return this.toInspect(rec);
    }
    const modelOnDisk = existsSync(model);
    const hfRepo = !isAbsolute(model) && model.includes("/");
    if (!modelOnDisk && !(isMlx && hfRepo)) {
      rec.status = "crashed";
      appendLog(rec, `${isMlx ? "revolver_mlx_server" : "llama-server"}: model not found: ${model}`);
      return this.toInspect(rec);
    }
    if (isMlx && modelOnDisk) {
      try {
        if (statSync(model).isDirectory() && !mlxTokenizerPresent(readdirSync(model))) {
          rec.status = "crashed";
          appendLog(
            rec,
            `revolver_mlx_server: missing tokenizer.json in ${model} — re-download the Hugging Face repo (tokenizer sidecars required)`,
          );
          return this.toInspect(rec);
        }
      } catch {
        /* spawn and let the server report */
      }
    }

    let child: ChildProcess;
    if (isMlx) {
      const mlx = probeMlxRuntime();
      if (!mlx.python) {
        rec.status = "crashed";
        appendLog(rec, `[native] ${mlx.error}`);
        return this.toInspect(rec);
      }
      const args = [
        "-W",
        "ignore::UserWarning",
        "-m",
        "revolver_mlx_server",
        "--model",
        model,
        "--host",
        fileEnv.MLX_HOST || "127.0.0.1",
        "--port",
        String(hostPort),
      ];
      appendLog(rec, `[native] revolver_mlx_server ${mlx.python} --model ${model} --port ${hostPort}`);
      child = spawn(mlx.python, args, {
        env: {
          ...process.env,
          ...fileEnv,
          ...this.opts.extraEnv,
        },
        // Avoid repo-root `mlx/` shadowing the pip mlx package on sys.path.
        cwd: dirname(mlx.python),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      const backend = (fileEnv.BACKEND ?? process.env.BACKEND ?? "cpu") as InferenceBackend;
      const resolved = resolveLlamaServerBin(this.opts.llamaServerBin, { backend });
      if (!resolved.bin) {
        rec.status = "crashed";
        appendLog(rec, `[native] ${resolved.error}`);
        return this.toInspect(rec);
      }
      if (resolved.packId) {
        appendLog(rec, `[native] backend pack ${resolved.packId} → ${resolved.bin}`);
      }

      const env: NodeJS.ProcessEnv = mergeLibPath(
        {
          ...process.env,
          ...fileEnv,
          ...this.opts.extraEnv,
          LLAMA_CONFIG_DIR: this.opts.configDir,
          LLAMA_ENV_FILE: llamaEnvFileName(serverId),
          LLAMA_HOST: "0.0.0.0",
          LLAMA_PORT: String(hostPort),
          LLAMA_SERVER_BIN: resolved.bin,
          LLAMA_NATIVE: "1",
          BACKEND: fileEnv.BACKEND ?? process.env.BACKEND ?? "cpu",
        },
        resolved.libDir,
      );

      if (process.platform === "win32") {
        const args = buildLlamaServerArgs(
          { ...fileEnv, LLAMA_HOST: "127.0.0.1", LLAMA_PORT: String(hostPort) },
          hostPort,
        );
        appendLog(rec, `[native] ${resolved.bin} ${args.join(" ")}`);
        appendLog(rec, llamaStartLogLine(fileEnv, model));
        const script = /\.(mjs|cjs|js)$/i.test(resolved.bin);
        child = spawn(script ? process.execPath : resolved.bin, script ? [resolved.bin, ...args] : args, {
          env,
          cwd: this.opts.configDir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } else {
        const entrypoint = join(this.opts.configDir, LLAMA_ENTRYPOINT_FILE);
        writeFileSync(entrypoint, LLAMA_ENTRYPOINT_SCRIPT);
        child = spawn("/bin/sh", [entrypoint], {
          env,
          cwd: this.opts.configDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    }

    rec.proc = child;
    rec.pid = child.pid ?? null;
    if (child.stdout) pipeOutput(rec, child.stdout);
    if (child.stderr) pipeOutput(rec, child.stderr);

    child.on("exit", (code, signal) => {
      if (rec.proc === child) {
        rec.proc = null;
        rec.pid = null;
        if (code === 0 && !signal) {
          rec.status = "idle";
        } else {
          rec.status = "crashed";
          appendLog(
            rec,
            `[native] ${isMlx ? "revolver_mlx_server" : "llama-server"} exited code=${code ?? "?"} signal=${signal ?? ""}`,
          );
        }
      }
    });

    await new Promise((r) => setTimeout(r, 300));
    if (rec.proc && !rec.proc.killed) {
      rec.status = "running";
    } else if (rec.status === "starting") {
      rec.status = "idle";
    }

    return this.toInspect(rec);
  }

  async stop(serverId: string): Promise<NativeServerInspect> {
    const rec = this.servers.get(serverId);
    if (!rec) {
      return {
        serverId,
        hostPort: 0,
        status: "stopped",
        pid: null,
        startedAt: null,
      };
    }
    await this.stopProcess(rec);
    await freeHostPort(rec.hostPort);
    rec.status = "stopped";
    return this.toInspect(rec);
  }

  inspect(serverId: string): NativeServerInspect {
    const rec = this.servers.get(serverId);
    if (!rec) {
      return {
        serverId,
        hostPort: 0,
        status: "stopped",
        pid: null,
        startedAt: null,
      };
    }
    if (rec.proc && !rec.proc.killed && rec.status !== "crashed") {
      rec.status = "running";
    }
    return this.toInspect(rec);
  }

  logs(serverId: string, tail = 200): string[] {
    const rec = this.servers.get(serverId);
    if (!rec) return [];
    return rec.logBuffer.slice(-tail);
  }

  list(): NativeServerInspect[] {
    return [...this.servers.values()].map((r) => this.toInspect(r));
  }

  private ensureRecord(serverId: string, hostPort: number): ServerRecord {
    this.ensure(serverId, hostPort);
    return this.servers.get(serverId)!;
  }

  private async stopProcess(rec: ServerRecord): Promise<void> {
    const proc = rec.proc;
    if (!proc || proc.killed) {
      rec.proc = null;
      rec.pid = null;
      return;
    }
    try {
      if (process.platform === "win32" && rec.pid) {
        spawn("taskkill", ["/PID", String(rec.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      rec.proc = null;
      rec.pid = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
        resolve();
      }, 8000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    rec.proc = null;
    rec.pid = null;
  }

  private toInspect(rec: ServerRecord): NativeServerInspect {
    return {
      serverId: rec.serverId,
      hostPort: rec.hostPort,
      status: rec.status,
      pid: rec.pid,
      startedAt: rec.startedAt,
    };
  }
}

let singleton: NativeSupervisor | null = null;

export function getNativeSupervisor(): NativeSupervisor {
  if (!singleton) {
    const configDir = process.env.LLAMA_CONFIG_DIR ?? join(getDataDir(), "llama-config");
    singleton = new NativeSupervisor({
      configDir,
      llamaServerBin: process.env.LLAMA_SERVER_BIN,
    });
  }
  return singleton;
}

export function resetNativeSupervisorForTests(): void {
  singleton = null;
}
