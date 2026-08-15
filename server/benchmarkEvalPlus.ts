import { join } from "path";
import type { BenchmarkCheckResult } from "../shared/benchmarks/types";
import { probeGeneration, type BenchTarget } from "./benchmarkChat";
import {
  benchWorkDir,
  cleanupWorkDir,
  containerLogTail,
  containerReachableBaseUrl,
  dockerAvailable,
  ensureDockerImage,
  readJsonIfExists,
  runBenchmarkContainer,
  type HarnessSummary,
} from "./benchmarkDockerHarness";
import { generationHealthChecks, scoreCheck } from "./benchmarkHarnessChecks";

const DEFAULT_IMAGE = process.env.REVOLVER_EVALPLUS_IMAGE ?? "revolver/evalplus:local";
const DEFAULT_TIMEOUT_MS = Number(process.env.REVOLVER_EVALPLUS_TIMEOUT_MS ?? 10_800_000);
const DEFAULT_MAX_NEW_TOKENS = process.env.REVOLVER_EVALPLUS_MAX_NEW_TOKENS ?? "4096";

export interface EvalPlusSuiteResult {
  checks: BenchmarkCheckResult[];
  output: string;
  artifacts: Array<{ name: string; content: string }>;
}

export function checksFromEvalPlus(
  summary: HarnessSummary | null,
  exitCode: number,
): BenchmarkCheckResult[] {
  const basePass1 = summary?.scores?.basePassAt1 ?? null;
  const plusPass1 = summary?.scores?.plusPassAt1 ?? null;
  const incomplete = summary?.incomplete === true || exitCode === 124;
  const harnessOk = exitCode === 0 && summary != null && basePass1 != null && !incomplete;

  const checks: BenchmarkCheckResult[] = [
    {
      id: "evalplus-completed",
      label: incomplete
        ? "EvalPlus run finished (incomplete — timed out or cancelled)"
        : "EvalPlus harness produced results",
      passed: harnessOk,
      detail: harnessOk
        ? undefined
        : summary == null
          ? `No summary from the container (exit ${exitCode}) — the harness never reported back.`
          : (summary.errors?.join("; ") || (incomplete ? `exit ${exitCode}` : `exit code ${exitCode}`)),
      weight: 1,
      kind: "health",
    },
    scoreCheck({
      id: "evalplus-base-pass-at-1",
      name: "HumanEval base pass@1",
      value: basePass1,
      weight: 8,
      missingDetail: "No pass@1 in the harness summary",
    }),
    scoreCheck({
      id: "evalplus-plus-pass-at-1",
      name: "HumanEval+ pass@1",
      value: plusPass1,
      weight: 12,
      missingDetail: "No plus pass@1 in the harness summary",
    }),
  ];

  const tasks = summary?.counts?.tasks;
  if (tasks != null) {
    checks.push({
      id: "evalplus-coverage",
      label: incomplete ? `Evaluated ${tasks} tasks (partial)` : `Evaluated ${tasks} tasks`,
      passed: tasks > 0 && !incomplete,
      detail: incomplete
        ? "Score is only over the tasks generated before the timeout — not a full HumanEval+ number."
        : undefined,
      weight: 1,
      kind: incomplete ? "health" : "info",
    });
  }

  checks.push(...generationHealthChecks("evalplus", summary));
  return checks;
}

export async function runEvalPlusSuite(
  target: BenchTarget,
  signal: AbortSignal,
  onProgress?: (tail: string) => void,
): Promise<EvalPlusSuiteResult> {
  if (!(await dockerAvailable())) {
    throw new Error("Docker is required for EvalPlus but is not available");
  }

  const maxNewTokens = Number(DEFAULT_MAX_NEW_TOKENS);
  const probe = await probeGeneration(target, { maxTokens: maxNewTokens, signal });
  if (!probe.ok) {
    throw new Error(`EvalPlus preflight failed — ${probe.reason}`);
  }

  await ensureDockerImage({
    image: DEFAULT_IMAGE,
    buildContextRel: "docker/evalplus",
  });

  const workDir = benchWorkDir("evalplus");
  const baseUrl = containerReachableBaseUrl(target);
  const dataset = process.env.REVOLVER_EVALPLUS_DATASET ?? "humaneval";
  const mini = process.env.REVOLVER_EVALPLUS_MINI !== "0";

  try {
    const run = await runBenchmarkContainer({
      image: DEFAULT_IMAGE,
      namePrefix: "revolver-evalplus",
      workDir,
      containerWorkDir: "/app",
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onLog: onProgress,
      env: {
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: target.apiKey ?? "revolver",
        OPENAI_KEY: target.apiKey ?? "revolver",
        EVALPLUS_MODEL: target.model,
        EVALPLUS_DATASET: dataset,
        EVALPLUS_MINI: mini ? "1" : "0",
        EVALPLUS_MAX_NEW_TOKENS: DEFAULT_MAX_NEW_TOKENS,
        EVALPLUS_REASONING_FALLBACK: process.env.REVOLVER_EVALPLUS_REASONING_FALLBACK ?? "1",
      },
    });

    // stdout is authoritative; the file copy is a fallback for a truncated log.
    const summary = run.summary ?? readJsonIfExists<HarnessSummary>(join(workDir, "summary.json"));
    const checks = checksFromEvalPlus(summary, run.exitCode);
    const basePass1 = summary?.scores?.basePassAt1 ?? null;
    const plusPass1 = summary?.scores?.plusPassAt1 ?? null;

    const output = [
      "EvalPlus — Docker harness",
      `API: ${baseUrl}`,
      `Model: ${target.model}`,
      `Dataset: ${dataset}${mini ? " (mini)" : ""}`,
      `Max new tokens: ${DEFAULT_MAX_NEW_TOKENS}`,
      `Exit: ${run.exitCode}${summary?.incomplete || run.exitCode === 124 ? " (incomplete)" : ""}`,
      basePass1 != null ? `base pass@1: ${(basePass1 * 100).toFixed(2)}%` : "base pass@1: n/a",
      plusPass1 != null ? `plus pass@1: ${(plusPass1 * 100).toFixed(2)}%` : "plus pass@1: n/a",
      summary?.counts?.tasks != null ? `tasks: ${summary.counts.tasks}` : "",
      summary?.generation
        ? `usable generations: ${summary.generation.samples - summary.generation.empty}/${summary.generation.samples}`
        : "",
      `preflight: ${probe.completionTokens ?? "?"} completion tokens, finish=${probe.finishReason ?? "?"}`,
      "",
      "--- container log (tail) ---",
      containerLogTail(run.stdout, run.stderr),
    ]
      .filter(Boolean)
      .join("\n");

    const artifacts: Array<{ name: string; content: string }> = [
      {
        name: "summary.json",
        content: JSON.stringify(summary ?? { error: "no summary emitted by harness" }, null, 2),
      },
      { name: "container.log", content: `${run.stdout}\n${run.stderr}` },
    ];

    const salvageable = run.exitCode === 124 || run.exitCode === 130 || run.exitCode === 137 || run.exitCode === 143;
    if (summary == null && run.exitCode !== 0 && !salvageable) {
      throw new Error(
        `EvalPlus harness returned no summary (exit ${run.exitCode}). See container.log artifact.\n` +
          containerLogTail(run.stdout, run.stderr, 20),
      );
    }

    return { checks, output, artifacts };
  } finally {
    if (process.env.REVOLVER_BENCH_KEEP_WORK !== "1") cleanupWorkDir(workDir);
  }
}
