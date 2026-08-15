/**
 * Shared helpers for running external coding benchmarks inside Docker.
 * Containers talk to the loaded Revolver server via an OpenAI-compatible base URL.
 *
 * Results never travel over a shared filesystem: harnesses print a summary block
 * on stdout and artifacts are pulled with `docker cp`. Both work identically when
 * the backend is an Electron host process and when it is a container driving the
 * host daemon, where backend paths and daemon paths do not match.
 */
import { execFile, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { promisify } from "util";
import { getRevolverRoot } from "../electron/lib/appRoot";
import { getDataDir } from "../electron/lib/config";
import type { BenchTarget } from "./benchmarkChat";

const execFileAsync = promisify(execFile);

const DOCKER_PULL_TIMEOUT_MS = 600_000;
const DOCKER_BUILD_TIMEOUT_MS = 1_200_000;
const DOCKER_CP_TIMEOUT_MS = 120_000;

export const SUMMARY_BEGIN = "<<<REVOLVER_SUMMARY";
export const SUMMARY_END = "REVOLVER_SUMMARY>>>";

/** Contract every harness image implements — see the entrypoints under docker/. */
export interface HarnessSummary {
  schema: number;
  suite: string;
  ok: boolean;
  /** Benchmark scores as fractions in [0,1]; null when the harness could not compute one. */
  scores: Record<string, number | null>;
  /** "native" when the tool reported the score, "computed" when the harness derived it. */
  scoreSource?: string;
  /** True when codegen/eval was cut short (timeout or signal) and scores are from a subset. */
  incomplete?: boolean;
  counts?: Record<string, number>;
  /** Sampling health — how many requests came back usable. */
  generation?: {
    samples: number;
    empty: number;
    truncated: number;
    nonemptyRate: number;
  };
  config?: Record<string, string | number | boolean | null>;
  files?: Record<string, string | null>;
  errors?: string[];
}

function decodeMountinfoField(field: string): string {
  return field.replace(/\\040/g, " ").replace(/\\011/g, "\t");
}

/** Host root of the mount that contains `abs`, per /proc/self/mountinfo. */
function hostPathFromMountinfo(abs: string): string | null {
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
      if (abs !== mp && !abs.startsWith(`${mp}/`)) continue;
      if (!best || mp.length > best.mp.length) best = { root, mp };
    }
    if (best?.root && best.root !== "/") {
      const rel = abs.slice(best.mp.length).replace(/^\//, "");
      return rel ? join(best.root, rel) : best.root;
    }
  } catch {
    /* not Linux, or no procfs */
  }
  return null;
}

/**
 * Host-side path for a path inside the backend container (compose).
 *
 * mountinfo wins over REVOLVER_HOST_ROOT: a subdirectory of the repo root may be
 * its own mount (e.g. /app/data is a named volume), in which case mapping it
 * through the repo root silently points at an unrelated host directory.
 */
export function resolveHostPath(localPath: string): string {
  const abs = resolve(localPath);
  if (process.env.REVOLVER_DOCKER !== "1") return abs;

  const fromMounts = hostPathFromMountinfo(abs);
  if (fromMounts) return fromMounts;

  const hostRoot = process.env.REVOLVER_HOST_ROOT?.trim();
  const repoRoot = getRevolverRoot();
  if (hostRoot && (abs === repoRoot || abs.startsWith(`${repoRoot}/`))) {
    return join(hostRoot, abs.slice(repoRoot.length).replace(/^\//, ""));
  }

  return abs;
}

/** Base URL a sibling container should use to reach the inference server. */
export function containerReachableBaseUrl(target: BenchTarget): string {
  const host =
    target.host === "127.0.0.1" || target.host === "localhost"
      ? "host.docker.internal"
      : target.host;
  return `http://${host}:${target.port}/v1`;
}

export { dockerAvailable } from "./containerUtils";

async function imageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image], {
      timeout: 30_000,
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

export async function ensureDockerImage(opts: {
  image: string;
  buildContextRel?: string;
  pull?: boolean;
}): Promise<void> {
  if (await imageExists(opts.image)) return;

  if (opts.pull) {
    await execFileAsync("docker", ["pull", opts.image], {
      timeout: DOCKER_PULL_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return;
  }

  if (!opts.buildContextRel) {
    throw new Error(`Docker image "${opts.image}" not found and no build context provided`);
  }

  // `docker build` reads the context on the daemon side, so it needs a host path.
  const localContext = join(getRevolverRoot(), opts.buildContextRel);
  const context = resolveHostPath(localContext);

  if (process.env.REVOLVER_DOCKER === "1" && !existsSync(localContext) && context === localContext) {
    throw new Error(
      `Docker image "${opts.image}" missing. Build it on the host ` +
        `(docker compose --profile bench build livecodebench evalplus) or set ` +
        `REVOLVER_HOST_ROOT to the absolute repo path so the backend can build it.`,
    );
  }

  await execFileAsync("docker", ["build", "-t", opts.image, context], {
    timeout: DOCKER_BUILD_TIMEOUT_MS,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/** Pull the summary block a harness prints between sentinels. Last block wins. */
export function extractHarnessSummary(text: string): HarnessSummary | null {
  let found: HarnessSummary | null = null;
  let from = 0;
  for (;;) {
    const start = text.indexOf(SUMMARY_BEGIN, from);
    if (start < 0) break;
    const bodyStart = start + SUMMARY_BEGIN.length;
    const end = text.indexOf(SUMMARY_END, bodyStart);
    if (end < 0) break;
    from = end + SUMMARY_END.length;
    try {
      const parsed = JSON.parse(text.slice(bodyStart, end)) as HarnessSummary;
      if (parsed && typeof parsed === "object") found = parsed;
    } catch {
      /* keep scanning — a later block may be well formed */
    }
  }
  return found;
}

/** docker --env-file syntax: bare KEY=VALUE lines, no quoting, no newlines. */
export function renderEnvFile(env: Record<string, string>): string {
  return (
    Object.entries(env)
      .map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, " ")}`)
      .join("\n") + "\n"
  );
}

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed summary block, when the harness emitted one. */
  summary: HarnessSummary | null;
  workDir: string;
}

async function dockerQuiet(args: string[], timeoutMs: number): Promise<void> {
  try {
    await execFileAsync("docker", args, {
      timeout: timeoutMs,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    /* best effort — cleanup and artifact copy must never fail a run */
  }
}

/** Keep a rolling log plus any in-progress summary block so we never OOM on verbose harnesses. */
class LogBuffer {
  private chunks: string[] = [];
  private size = 0;
  private readonly maxBytes: number;
  full = "";

  constructor(maxBytes = 2_000_000) {
    this.maxBytes = maxBytes;
  }

  append(chunk: string): void {
    this.full += chunk;
    // Only retain the whole stream up to maxBytes; always keep a tail for display.
    if (this.full.length > this.maxBytes * 2) {
      this.full = this.full.slice(-this.maxBytes);
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
    }
  }

  text(): string {
    return this.chunks.join("");
  }
}

/**
 * One docker coding harness at a time — they share the same GPU-backed model and
 * concurrent runs look like hangs (requests queue behind each other for hours).
 */
let dockerHarnessQueue: Promise<void> = Promise.resolve();

export async function withDockerHarnessLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = dockerHarnessQueue;
  dockerHarnessQueue = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Create → start → copy artifacts → remove. Secrets go through an --env-file
 * (mode 0600) rather than `-e`, which would expose them in `docker inspect`.
 */
export async function runBenchmarkContainer(opts: {
  image: string;
  namePrefix: string;
  /** Backend-local directory that receives artifacts copied out of the container. */
  workDir: string;
  /** Working directory inside the container; its contents are copied to workDir. */
  containerWorkDir: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  /** Extra `docker create` flags, inserted before the image. */
  extraArgs?: string[];
  /** Overrides the image command, appended after the image. */
  command?: string[];
  /** Fired with the latest log tail so the UI can show progress during long runs. */
  onLog?: (tail: string) => void;
}): Promise<DockerRunResult> {
  return withDockerHarnessLock(() => runBenchmarkContainerUnlocked(opts));
}

async function runBenchmarkContainerUnlocked(opts: {
  image: string;
  namePrefix: string;
  workDir: string;
  containerWorkDir: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  extraArgs?: string[];
  command?: string[];
  onLog?: (tail: string) => void;
}): Promise<DockerRunResult> {
  mkdirSync(opts.workDir, { recursive: true });

  const name = `${opts.namePrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const envFile = join(opts.workDir, "container.env");
  writeFileSync(envFile, renderEnvFile(opts.env), { mode: 0o600 });

  const baseCreateArgs = [
    "create",
    "--name",
    name,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env-file",
    envFile,
    "-w",
    opts.containerWorkDir,
  ];
  if (process.env.REVOLVER_BENCH_CPUS) baseCreateArgs.push("--cpus", process.env.REVOLVER_BENCH_CPUS);
  if (process.env.REVOLVER_BENCH_MEMORY) {
    baseCreateArgs.push("--memory", process.env.REVOLVER_BENCH_MEMORY);
  }

  const pidsLimit = process.env.REVOLVER_BENCH_PIDS_LIMIT ?? "2048";
  const withPids = [...baseCreateArgs, "--pids-limit", pidsLimit, ...(opts.extraArgs ?? []), opts.image, ...(opts.command ?? [])];
  const withoutPids = [...baseCreateArgs, ...(opts.extraArgs ?? []), opts.image, ...(opts.command ?? [])];

  try {
    await execFileAsync("docker", withPids, { timeout: 60_000, env: process.env });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Some engines (rootless, older dockerd) reject --pids-limit.
    if (/pids.?limit|PidsLimit|unknown flag/i.test(msg) || /invalid/i.test(msg)) {
      await execFileAsync("docker", withoutPids, { timeout: 60_000, env: process.env });
    } else {
      rmSync(envFile, { force: true });
      throw e;
    }
  }

  try {
    const run = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolvePromise, reject) => {
        const child = spawn("docker", ["start", "--attach", name], {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdoutBuf = new LogBuffer();
        const stderrBuf = new LogBuffer();
        let settled = false;
        let lastNotify = 0;

        const notify = () => {
          if (!opts.onLog) return;
          const now = Date.now();
          if (now - lastNotify < 2000) return;
          lastNotify = now;
          opts.onLog(containerLogTail(stdoutBuf.text(), stderrBuf.text(), 30));
        };

        const finish = (err: Error | null, exitCode: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolvePromise({ exitCode, stdout: stdoutBuf.full, stderr: stderrBuf.full });
        };

        /** SIGTERM first so the harness can evaluate whatever it already generated. */
        const stopThen = (graceSec: number, exitCode: number, note: string) => {
          stdoutBuf.append(`\n[revolver] ${note}\n`);
          notify();
          void dockerQuiet(["stop", "-t", String(graceSec), name], (graceSec + 30) * 1000).then(() => {
            child.kill("SIGKILL");
            finish(null, exitCode);
          });
        };

        const onAbort = () => {
          stopThen(15, 130, "cancelled — SIGTERM (15s grace)");
        };
        opts.signal.addEventListener("abort", onAbort);

        const timer = setTimeout(() => {
          stopThen(
            90,
            124,
            `timed out after ${opts.timeoutMs}ms — SIGTERM (90s grace to flush results)`,
          );
        }, opts.timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBuf.append(chunk.toString("utf8"));
          notify();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBuf.append(chunk.toString("utf8"));
          notify();
        });
        child.on("error", (e) => finish(e, 1));
        child.on("close", (code) => finish(null, code ?? 1));
      },
    );

    // Streams over the docker socket, so the destination is a backend-local path.
    await dockerQuiet(
      ["cp", `${name}:${opts.containerWorkDir}/.`, opts.workDir],
      DOCKER_CP_TIMEOUT_MS,
    );

    return {
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      summary: extractHarnessSummary(`${run.stdout}\n${run.stderr}`),
      workDir: opts.workDir,
    };
  } finally {
    rmSync(envFile, { force: true });
    await dockerQuiet(["rm", "-f", name], 60_000);
  }
}

export function benchWorkDir(suiteId: string): string {
  const dir = join(getDataDir(), "benchmarks", "docker-work", suiteId, `${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function cleanupWorkDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* keep on failure for inspection */
  }
}

/** Tail of the combined container log with the summary block stripped out. */
export function containerLogTail(stdout: string, stderr: string, lines = 60): string {
  const combined = `${stdout}\n${stderr}`;
  const cleaned = combined.replace(
    new RegExp(`${SUMMARY_BEGIN}[\\s\\S]*?${SUMMARY_END}`, "g"),
    "",
  );
  return cleaned.trim().split("\n").slice(-lines).join("\n");
}
