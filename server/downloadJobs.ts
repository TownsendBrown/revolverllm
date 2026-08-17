import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../electron/lib/config";
import { getDataDir } from "../electron/lib/config";
import { loadSettings } from "../electron/lib/settings";
import type { DownloadJob, DownloadJobStatus, StartModelDownloadRequest } from "../shared/types";
import { mergeWithCompanions } from "../shared/hubDownloadFiles";
import { downloadFile, listRepoFiles, probeRepoSize } from "./hfHub";

const jobs = new Map<string, DownloadJob>();
let activeJobId: string | null = null;

function jobsDir(): string {
  const dir = join(getDataDir(), "downloads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function persistJob(job: DownloadJob): void {
  writeFileSync(join(jobsDir(), `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}

function loadPersistedJobs(): void {
  jobsDir();
  for (const f of readdirSync(jobsDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(jobsDir(), f), "utf8")) as DownloadJob;
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

function updateJob(id: string, patch: Partial<DownloadJob>): DownloadJob {
  const cur = jobs.get(id);
  if (!cur) throw new Error("Download job not found");
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(id, next);
  persistJob(next);
  return next;
}

function freeBytesForPath(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    return Number(st.bsize) * Number(st.bavail);
  } catch {
    return null;
  }
}

function destDir(dest: "hub" | "models", repoId: string): string {
  const cfg = loadConfig();
  if (dest === "models") {
    const base = cfg.modelsDir;
    const name = repoId.split("/").pop() ?? repoId.replace("/", "-");
    return join(base, name);
  }
  return join(cfg.hubModelsDir, ...repoId.split("/"));
}

const abortControllers = new Map<string, AbortController>();

export function listDownloadJobs(): DownloadJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDownloadJob(id: string): DownloadJob | null {
  return jobs.get(id) ?? null;
}

export async function startDownload(req: StartModelDownloadRequest): Promise<DownloadJob> {
  const settings = loadSettings();
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active && (active.status === "running" || active.status === "queued")) {
      throw new Error("Another download is already in progress");
    }
  }

  const repoId = req.repoId.trim();
  const revision = req.revision?.trim() || "main";
  const dest = req.dest ?? settings.downloads.dest;
  const targetDir = destDir(dest, repoId);

  const bytesTotal = await probeRepoSize(repoId, revision, req.files ?? null);
  const free = freeBytesForPath(loadConfig().modelsDir);
  if (bytesTotal != null && free != null && bytesTotal > free) {
    throw new Error(
      `Not enough disk space (need ~${Math.ceil(bytesTotal / 1024 ** 3)} GB, ${Math.floor(free / 1024 ** 3)} GB free)`,
    );
  }

  const id = randomUUID();
  const job: DownloadJob = {
    id,
    repoId,
    revision,
    dest,
    files: req.files ?? null,
    status: "queued",
    progress: 0,
    bytesDone: 0,
    bytesTotal,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    localPath: targetDir,
  };
  jobs.set(id, job);
  persistJob(job);
  activeJobId = id;
  void runJob(id);
  return job;
}

async function runJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  const ac = new AbortController();
  abortControllers.set(id, ac);
  updateJob(id, { status: "running", progress: 0 });

  try {
    mkdirSync(job.localPath!, { recursive: true });
    const allFiles = await listRepoFiles(job.repoId, job.revision);
    let files = allFiles;
    if (job.files?.length) {
      const set = new Set(job.files);
      const picked = allFiles.filter(
        (f) => set.has(f.path) || [...set].some((s) => f.path.endsWith(`/${s}`)),
      );
      const merged = new Set(
        mergeWithCompanions(
          allFiles.map((f) => f.path),
          picked.map((f) => f.path),
        ),
      );
      files = allFiles.filter((f) => merged.has(f.path));
    } else {
      files = allFiles.filter(
        (f) =>
          f.path.endsWith(".gguf") ||
          f.path.endsWith(".safetensors") ||
          f.path.endsWith(".json") ||
          f.path.endsWith(".model") ||
          f.path.endsWith(".txt") ||
          f.path.endsWith(".jinja"),
      );
      if (!files.some((f) => f.path.endsWith(".gguf") || f.path.endsWith(".safetensors"))) {
        files = allFiles.filter((f) => !f.path.includes("/") || f.path.split("/").length <= 2);
      }
    }

    if (!files.length) throw new Error("No downloadable files matched");

    let doneBytes = 0;
    const total = job.bytesTotal ?? files.reduce((s, f) => s + (f.size ?? 0), 0);

    for (const file of files) {
      if (ac.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const destPath = join(job.localPath!, file.path);
      if (existsSync(destPath) && file.size != null) {
        try {
          if (statSync(destPath).size === file.size) {
            doneBytes += file.size;
            continue;
          }
        } catch {
          /* re-download */
        }
      }
      await downloadFile({
        repoId: job.repoId,
        revision: job.revision,
        path: file.path,
        destPath,
        signal: ac.signal,
        onProgress: (n) => {
          const bytesDone = doneBytes + n;
          updateJob(id, {
            bytesDone,
            progress: total > 0 ? Math.min(99, Math.round((bytesDone / total) * 100)) : 0,
          });
        },
      });
      doneBytes += file.size ?? 0;
      updateJob(id, {
        bytesDone: doneBytes,
        progress: total > 0 ? Math.min(99, Math.round((doneBytes / total) * 100)) : 50,
      });
    }

    updateJob(id, { status: "done", progress: 100, bytesDone: doneBytes, bytesTotal: total });
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
  }
}

export function cancelDownloadJob(id: string): DownloadJob {
  const job = jobs.get(id);
  if (!job) throw new Error("Download job not found");
  abortControllers.get(id)?.abort();
  if (job.status === "queued" || job.status === "running") {
    return updateJob(id, { status: "cancelled", error: "cancelled" });
  }
  return job;
}
