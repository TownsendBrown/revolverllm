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

const DEFAULT_IMAGE = process.env.REVOLVER_LCB_IMAGE ?? "revolver/livecodebench:local";
const DEFAULT_TIMEOUT_MS = Number(process.env.REVOLVER_LCB_TIMEOUT_MS ?? 7_200_000);
const DEFAULT_MAX_TOKENS = process.env.REVOLVER_LCB_MAX_TOKENS ?? "8000";

export interface LiveCodeBenchSuiteResult {
  checks: BenchmarkCheckResult[];
  output: string;
  artifacts: Array<{ name: string; content: string }>;
}

export function checksFromLiveCodeBench(
  summary: HarnessSummary | null,
  exitCode: number,
): BenchmarkCheckResult[] {
  const passAt1 = summary?.scores?.passAt1 ?? null;
  const passAt5 = summary?.scores?.passAt5 ?? null;
  const incomplete = summary?.incomplete === true || exitCode === 124;
  const harnessOk = exitCode === 0 && summary != null && passAt1 != null && !incomplete;

  const checks: BenchmarkCheckResult[] = [
    {
      id: "lcb-completed",
      label: incomplete
        ? "LiveCodeBench run finished (incomplete — timed out or cancelled)"
        : "LiveCodeBench harness produced results",
      passed: harnessOk,
      detail: harnessOk
        ? undefined
        : summary == null
          ? `No summary from the container (exit ${exitCode}) — the harness never reported back.`
          : (summary.errors?.join("; ") ?? `exit code ${exitCode}`),
      weight: 1,
      kind: "health",
    },
    scoreCheck({
      id: "lcb-pass-at-1",
      name: "pass@1",
      value: passAt1,
      weight: 10,
      missingDetail: "No pass@1 in the harness summary",
    }),
  ];

  if (passAt5 != null) {
    checks.push(
      scoreCheck({
        id: "lcb-pass-at-5",
        name: "pass@5",
        value: passAt5,
        weight: 5,
        missingDetail: "No pass@5 in the harness summary",
      }),
    );
  }

  const problems = summary?.counts?.problems;
  if (problems != null) {
    checks.push({
      id: "lcb-coverage",
      label: `Evaluated ${problems} problems`,
      passed: problems > 0,
      weight: 1,
      kind: "info",
    });
  }

  checks.push(...generationHealthChecks("lcb", summary));
  return checks;
}

export async function runLiveCodeBenchSuite(
  target: BenchTarget,
  signal: AbortSignal,
  onProgress?: (tail: string) => void,
): Promise<LiveCodeBenchSuiteResult> {
  if (!(await dockerAvailable())) {
    throw new Error("Docker is required for LiveCodeBench but is not available");
  }

  const probe = await probeGeneration(target, { maxTokens: Number(DEFAULT_MAX_TOKENS), signal });
  if (!probe.ok) {
    throw new Error(`LiveCodeBench preflight failed — ${probe.reason}`);
  }

  await ensureDockerImage({
    image: DEFAULT_IMAGE,
    buildContextRel: "docker/livecodebench",
  });

  const workDir = benchWorkDir("livecodebench");
  const baseUrl = containerReachableBaseUrl(target);
  const full = process.env.REVOLVER_LCB_FULL === "1";
  const release = process.env.REVOLVER_LCB_RELEASE ?? "release_v1";

  try {
    const run = await runBenchmarkContainer({
      image: DEFAULT_IMAGE,
      namePrefix: "revolver-lcb",
      workDir,
      containerWorkDir: "/work",
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onLog: onProgress,
      env: {
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: target.apiKey ?? "revolver",
        OPENAI_KEY: target.apiKey ?? "revolver",
        LCB_MODEL: target.model,
        LCB_N: process.env.REVOLVER_LCB_N ?? "1",
        LCB_TEMPERATURE: process.env.REVOLVER_LCB_TEMPERATURE ?? "0.2",
        LCB_MAX_TOKENS: DEFAULT_MAX_TOKENS,
        LCB_RELEASE_VERSION: release,
        LCB_MULTIPROCESS: process.env.REVOLVER_LCB_MULTIPROCESS ?? "1",
        LCB_FULL: full ? "1" : "0",
        LCB_TIMEOUT: process.env.REVOLVER_LCB_EVAL_TIMEOUT ?? "12",
        LCB_OPENAI_TIMEOUT: process.env.REVOLVER_LCB_OPENAI_TIMEOUT ?? "600",
        LCB_REASONING_FALLBACK: process.env.REVOLVER_LCB_REASONING_FALLBACK ?? "1",
      },
    });

    const summary = run.summary ?? readJsonIfExists<HarnessSummary>(join(workDir, "summary.json"));
    const checks = checksFromLiveCodeBench(summary, run.exitCode);
    const passAt1 = summary?.scores?.passAt1 ?? null;
    const passAt5 = summary?.scores?.passAt5 ?? null;

    const output = [
      "LiveCodeBench (code generation) — Docker harness",
      `API: ${baseUrl}`,
      `Model: ${target.model}`,
      `Release: ${release}`,
      `Mode: ${full ? "full release" : "debug (15 problems)"}`,
      `Max tokens: ${DEFAULT_MAX_TOKENS}`,
      `Exit: ${run.exitCode}`,
      passAt1 != null ? `pass@1: ${(passAt1 * 100).toFixed(2)}%` : "pass@1: n/a",
      passAt5 != null ? `pass@5: ${(passAt5 * 100).toFixed(2)}%` : "pass@5: n/a",
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
        `LiveCodeBench harness returned no summary (exit ${run.exitCode}). See container.log artifact.\n` +
          containerLogTail(run.stdout, run.stderr, 20),
      );
    }

    return { checks, output, artifacts };
  } finally {
    if (process.env.REVOLVER_BENCH_KEEP_WORK !== "1") cleanupWorkDir(workDir);
  }
}
