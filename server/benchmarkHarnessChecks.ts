/**
 * Checks shared by the Docker coding harnesses (EvalPlus, LiveCodeBench).
 *
 * Scores and run health are deliberately separate: a model that returns empty
 * completions scores 0% for reasons that have nothing to do with its coding
 * ability, and that distinction has to survive into the UI.
 */
import type { BenchmarkCheckResult } from "../shared/benchmarks/types";
import type { HarnessSummary } from "./benchmarkDockerHarness";

/** Below this share of usable completions the run measures plumbing, not skill. */
const MIN_NONEMPTY_RATE = 0.9;

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function scoreCheck(opts: {
  id: string;
  name: string;
  value: number | null;
  weight: number;
  missingDetail: string;
}): BenchmarkCheckResult {
  if (opts.value == null) {
    return {
      id: opts.id,
      label: `${opts.name} unavailable`,
      passed: false,
      detail: opts.missingDetail,
      weight: opts.weight,
      kind: "score",
      value: null,
      unit: "%",
    };
  }
  return {
    id: opts.id,
    label: `${opts.name} = ${formatPercent(opts.value)}`,
    passed: opts.value > 0,
    detail: `Raw ${opts.value}`,
    weight: opts.weight,
    kind: "score",
    value: opts.value,
    unit: "%",
  };
}

export function generationHealthChecks(
  prefix: string,
  summary: HarnessSummary | null,
): BenchmarkCheckResult[] {
  const generation = summary?.generation;
  if (!generation || generation.samples === 0) return [];

  const usable = generation.samples - generation.empty;
  const checks: BenchmarkCheckResult[] = [
    {
      id: `${prefix}-generation-health`,
      label: `Usable completions ${usable}/${generation.samples} (${formatPercent(generation.nonemptyRate)})`,
      passed: generation.nonemptyRate >= MIN_NONEMPTY_RATE,
      detail:
        `${generation.empty} request(s) returned no answer. Reasoning models often spend the ` +
        "whole token budget thinking — raise the harness token budget or disable thinking. " +
        "Scores from this run understate the model.",
      weight: 3,
      kind: "health",
      value: generation.nonemptyRate,
      unit: "%",
    },
  ];

  if (generation.truncated > 0) {
    checks.push({
      id: `${prefix}-truncation`,
      label: `${generation.truncated}/${generation.samples} completions hit the token limit`,
      passed: false,
      detail: "Truncated answers cannot compile — raise the harness token budget.",
      weight: 1,
      kind: "health",
      value: generation.truncated / generation.samples,
      unit: "%",
    });
  }

  return checks;
}
