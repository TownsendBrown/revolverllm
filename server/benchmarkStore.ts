import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getDataDir } from "../electron/lib/config";
import type { BenchmarkRun, BenchmarkTestResult } from "../shared/benchmarks/types";

function benchmarksRoot(): string {
  const root = join(getDataDir(), "benchmarks");
  mkdirSync(root, { recursive: true });
  return root;
}

function runsDir(): string {
  const dir = join(benchmarksRoot(), "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runPath(id: string): string {
  return join(runsDir(), `${id}.json`);
}

function runArtifactsDir(id: string): string {
  const dir = join(runsDir(), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRunArtifactsDir(runId: string): string {
  return runArtifactsDir(runId);
}

export function saveRun(run: BenchmarkRun): void {
  writeFileSync(runPath(run.id), JSON.stringify(run, null, 2) + "\n");
}

export function getRun(id: string): BenchmarkRun | null {
  const path = runPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BenchmarkRun;
  } catch {
    return null;
  }
}

export function listRuns(): BenchmarkRun[] {
  const dir = runsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const runs: BenchmarkRun[] = [];
  for (const file of files) {
    try {
      const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as BenchmarkRun;
      runs.push(run);
    } catch {
      /* skip corrupt */
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs;
}

export function deleteRun(id: string): void {
  const path = runPath(id);
  if (existsSync(path)) rmSync(path);
  const artDir = join(runsDir(), id);
  if (existsSync(artDir)) rmSync(artDir, { recursive: true, force: true });
}

export function updateTestResult(runId: string, testId: string, patch: Partial<BenchmarkTestResult>): void {
  const run = getRun(runId);
  if (!run) return;
  const idx = run.results.findIndex((r) => r.testId === testId);
  if (idx < 0) return;
  run.results[idx] = { ...run.results[idx], ...patch };
  saveRun(run);
}

export function writeArtifact(runId: string, testId: string, filename: string, content: string): string {
  const dir = join(runArtifactsDir(runId), testId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content, "utf8");
  return `${testId}/${filename}`;
}

export function readArtifact(runId: string, relPath: string): Buffer | null {
  const full = join(runArtifactsDir(runId), relPath);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full);
  } catch {
    return null;
  }
}

export function resolveArtifactPath(runId: string, relPath: string): string | null {
  const full = join(runArtifactsDir(runId), relPath);
  if (!existsSync(full)) return null;
  return full;
}
