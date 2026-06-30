import { spawn, execFile, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import type { ServerInspect } from "./protocol.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const ENTRYPOINT = join(REPO_ROOT, "llama-server/entrypoint.sh");

export interface SupervisorOptions {
  configDir: string;
  modelsHostDir: string;
  llamaServerBin?: string;
}

interface ServerRecord {
  serverId: string;
  hostPort: number;
  proc: ChildProcessWithoutNullStreams | null;
  status: "idle" | "starting" | "running" | "stopped" | "crashed";
  pid: number | null;
  startedAt: string | null;
  logBuffer: string[];
}

const MAX_LOG_LINES = 4000;

function envFileName(serverId: string): string {
  return `llama-load-${serverId}.env`;
}

function appendLog(rec: ServerRecord, line: string): void {
  rec.logBuffer.push(line);
  if (rec.logBuffer.length > MAX_LOG_LINES) {
    rec.logBuffer.splice(0, rec.logBuffer.length - MAX_LOG_LINES);
  }
}

/** Kill any process listening on hostPort (orphan llama-server from prior runs). */
async function freeHostPort(port: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `tcp:${port}`], { timeout: 5000 });
    const pids = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => Number(p))
      .filter((p) => p > 0 && p !== process.pid);
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  } catch {
    /* port free or lsof unavailable */
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

export class Supervisor {
  private servers = new Map<string, ServerRecord>();

  constructor(private opts: SupervisorOptions) {
    mkdirSync(opts.configDir, { recursive: true });
  }

  ensure(serverId: string, hostPort: number): ServerInspect {
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
    return this.inspect(serverId);
  }

  async restart(serverId: string, hostPort: number): Promise<ServerInspect> {
    const rec = this.ensureRecord(serverId, hostPort);
    await this.stopProcess(rec);
    await freeHostPort(hostPort);
    rec.logBuffer = [];
    rec.status = "starting";
    rec.startedAt = new Date().toISOString();

    const envPath = join(this.opts.configDir, envFileName(serverId));
    if (!existsSync(envPath)) {
      rec.status = "idle";
      appendLog(rec, "llama-server: no model configured — idle (load via manager)");
      return this.toInspect(rec);
    }

    if (!existsSync(ENTRYPOINT)) {
      rec.status = "crashed";
      appendLog(rec, `[host-agent] entrypoint missing: ${ENTRYPOINT}`);
      return this.toInspect(rec);
    }

    const env = {
      ...process.env,
      LLAMA_CONFIG_DIR: this.opts.configDir,
      LLAMA_ENV_FILE: envFileName(serverId),
      LLAMA_HOST: "0.0.0.0",
      LLAMA_PORT: String(hostPort),
      MODELS_HOST_DIR: this.opts.modelsHostDir,
      BACKEND: "metal",
      ...(this.opts.llamaServerBin ? { LLAMA_SERVER_BIN: this.opts.llamaServerBin } : {}),
    };

    const child = spawn("/bin/sh", [ENTRYPOINT], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    rec.proc = child;
    rec.pid = child.pid ?? null;
    pipeOutput(rec, child.stdout);
    pipeOutput(rec, child.stderr);

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
            `[host-agent] llama-server exited code=${code ?? "?"} signal=${signal ?? ""}`,
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

  async stop(serverId: string): Promise<ServerInspect> {
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
    rec.status = "stopped";
    return this.toInspect(rec);
  }

  inspect(serverId: string): ServerInspect {
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

  list(): ServerInspect[] {
    return [...this.servers.values()].map((r) => this.toInspect(r));
  }

  private ensureRecord(serverId: string, hostPort: number): ServerRecord {
    this.ensure(serverId, hostPort);
    return this.servers.get(serverId)!;
  }

  private async stopProcess(rec: ServerRecord): Promise<void> {
    const proc = rec.proc;
    if (!proc || proc.killed) return;
    proc.kill("SIGTERM");
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

  private toInspect(rec: ServerRecord): ServerInspect {
    return {
      serverId: rec.serverId,
      hostPort: rec.hostPort,
      status: rec.status,
      pid: rec.pid,
      startedAt: rec.startedAt,
    };
  }
}
