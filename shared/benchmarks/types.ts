/** Benchmark definition version — bump when prompts or scoring change. */
export type BenchmarkDefinitionVersion = string;

export type BenchmarkCategory =
  | "website-generation"
  | "platformer-game"
  | "livecodebench"
  | "evalplus"
  | "frontend-design"
  | "performance"
  | "context-retrieval"
  | "agency";

export interface BenchmarkDefinition {
  id: BenchmarkCategory;
  version: BenchmarkDefinitionVersion;
  name: string;
  description: string;
  /** Whether human grading is supported for this test. */
  supportsHumanEval: boolean;
  /**
   * "generation": single prompt, output graded by static evaluators.
   * "suite": multi-request procedure with its own server-side runner.
   */
  kind: "generation" | "suite";
  /** Prompt sent to the model — generation tests only. */
  prompt?: string;
}

export type BenchmarkRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BenchmarkRunConfig {
  serverId: string;
  modelId: string | null;
  modelDisplayName: string | null;
  engineId: string | null;
  backendId: string | null;
  contextLength: number | null;
  nGpuLayers: number | null;
  enableThinking: boolean;
  testIds: BenchmarkCategory[];
}

/**
 * "score": a benchmark metric such as pass@1.
 * "health": whether the run itself was valid (e.g. the model answered at all).
 * "info": context that carries no judgement.
 */
export type BenchmarkCheckKind = "score" | "health" | "info";

export interface BenchmarkCheckResult {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
  /** Relative importance of this check when scoring. Defaults to 1. */
  weight?: number;
  kind?: BenchmarkCheckKind;
  /** Underlying measurement as a fraction in [0,1], for score/health checks. */
  value?: number | null;
  unit?: string;
}

export interface BenchmarkTestResult {
  testId: BenchmarkCategory;
  definitionVersion: BenchmarkDefinitionVersion;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  /** Raw model output. */
  output: string | null;
  reasoning: string | null;
  automatedScore: number | null;
  automatedMaxScore: number | null;
  checks: BenchmarkCheckResult[];
  humanScore: number | null;
  humanMaxScore: number | null;
  humanNotes: string | null;
  combinedScore: number | null;
  error: string | null;
  /** Relative artifact paths under the run directory. */
  artifacts: string[];
  metrics: {
    promptTokens: number | null;
    completionTokens: number | null;
    tokensPerSecond: number | null;
    ttftMs: number | null;
    elapsedMs: number | null;
  } | null;
}

export interface BenchmarkRun {
  id: string;
  status: BenchmarkRunStatus;
  config: BenchmarkRunConfig;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  results: BenchmarkTestResult[];
  error: string | null;
}

export interface StartBenchmarkRequest {
  serverId: string;
  testIds?: BenchmarkCategory[];
  enableThinking?: boolean;
}

export interface SetHumanScoreRequest {
  humanScore: number;
  humanMaxScore?: number;
  humanNotes?: string;
}
