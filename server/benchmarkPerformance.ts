import type { BenchmarkCheckResult } from "../shared/benchmarks/types";
import { buildHaystack } from "../shared/benchmarks/retrieval";
import {
  chatOnce,
  countTokens,
  median,
  padToTokenCount,
  toCsv,
  type BenchTarget,
} from "./benchmarkChat";

export const PERF_SCENARIO_TARGETS = [512, 1024, 2048, 4096, 8192];
export const PERF_TRIALS = 3;
export const PERF_DECODE_TOKENS = 128;
const PERF_SEED = 42;

const FILLER = buildHaystack(400, 7);

interface TrialTiming {
  promptTokens: number | null;
  prefillTps: number | null;
  decodeTps: number | null;
  elapsedMs: number;
}

export interface PerformanceSuiteResult {
  checks: BenchmarkCheckResult[];
  output: string;
  artifacts: Array<{ name: string; content: string }>;
  medianDecodeTps: number | null;
}

function extractTiming(r: Awaited<ReturnType<typeof chatOnce>>): TrialTiming {
  const t = r.timings;
  let prefillTps = t?.prompt_per_second ?? null;
  if (prefillTps == null && t?.prompt_n != null && t?.prompt_ms != null && t.prompt_ms > 0) {
    prefillTps = (t.prompt_n / t.prompt_ms) * 1000;
  }
  let decodeTps = t?.predicted_per_second ?? null;
  if (decodeTps == null && t?.predicted_n != null && t?.predicted_ms != null && t.predicted_ms > 0) {
    decodeTps = (t.predicted_n / t.predicted_ms) * 1000;
  }
  return {
    promptTokens: r.usage?.prompt_tokens ?? t?.prompt_n ?? null,
    prefillTps,
    decodeTps,
    elapsedMs: r.elapsedMs,
  };
}

const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

export async function runPerformanceSuite(
  target: BenchTarget,
  contextLength: number | null,
  signal: AbortSignal,
): Promise<PerformanceSuiteResult> {
  const ctx = contextLength && contextLength > 0 ? contextLength : 4096;
  // Leave room for decode output plus chat-template overhead.
  const usable = ctx - PERF_DECODE_TOKENS - 128;
  const scenarios = PERF_SCENARIO_TARGETS.filter((t) => t <= usable);
  const skipped = PERF_SCENARIO_TARGETS.filter((t) => t > usable);

  const tokenizerExact = (await countTokens(target, FILLER)) != null;
  const checks: BenchmarkCheckResult[] = [];
  const csvRows: Array<Array<string | number | null>> = [];
  const summaryLines: string[] = [
    `Performance benchmark — ${PERF_TRIALS} trials/scenario (+1 warmup), median reported.`,
    `Settings: temperature 0, seed ${PERF_SEED}, prompt cache disabled, ${PERF_DECODE_TOKENS} decode tokens.`,
    `Prompt sizing: ${tokenizerExact ? "server tokenizer (token-exact)" : "character heuristic (server /tokenize unavailable)"}.`,
    "",
    "| Target ctx | Actual prompt tok | Prefill tok/s (median) | Decode tok/s (median) |",
    "|---|---|---|---|",
  ];
  const allDecodeMedians: number[] = [];

  for (const targetTokens of scenarios) {
    if (signal.aborted) throw new Error("Cancelled");

    const base =
      "You are a summarization service. After the document below, reply with exactly one sentence summarizing it.\n\n";
    const padded = await padToTokenCount(target, base, FILLER, targetTokens);
    const messages = [{ role: "user", content: padded.text }];
    const opts = {
      temperature: 0,
      seed: PERF_SEED,
      maxTokens: PERF_DECODE_TOKENS,
      cachePrompt: false,
      signal,
    };

    try {
      await chatOnce(target, messages, opts); // warmup — discard cache/alloc effects

      const trials: TrialTiming[] = [];
      for (let i = 0; i < PERF_TRIALS; i++) {
        if (signal.aborted) throw new Error("Cancelled");
        const res = await chatOnce(target, messages, opts);
        const timing = extractTiming(res);
        trials.push(timing);
        csvRows.push([
          targetTokens,
          i + 1,
          timing.promptTokens,
          r1(timing.prefillTps),
          r1(timing.decodeTps),
          timing.elapsedMs,
        ]);
      }

      const prefillMed = r1(median(trials.map((t) => t.prefillTps ?? NaN)));
      const decodeMed = r1(median(trials.map((t) => t.decodeTps ?? NaN)));
      if (decodeMed != null) allDecodeMedians.push(decodeMed);
      const promptTokens = trials[0].promptTokens ?? padded.tokens;

      summaryLines.push(`| ${targetTokens} | ${promptTokens} | ${prefillMed ?? "—"} | ${decodeMed ?? "—"} |`);
      checks.push({
        id: `perf-${targetTokens}`,
        label: `${targetTokens}-token context measured`,
        passed: prefillMed != null && decodeMed != null,
        detail:
          prefillMed != null && decodeMed != null
            ? `prefill ${prefillMed} tok/s, decode ${decodeMed} tok/s (median of ${PERF_TRIALS})`
            : "server did not report prefill/decode timings",
      });
    } catch (e) {
      if (signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      checks.push({
        id: `perf-${targetTokens}`,
        label: `${targetTokens}-token context measured`,
        passed: false,
        detail: msg.slice(0, 200),
      });
      summaryLines.push(`| ${targetTokens} | — | error | error |`);
    }
  }

  for (const t of skipped) {
    summaryLines.push(`| ${t} | — | skipped (exceeds ${ctx}-token context) | — |`);
  }

  return {
    checks,
    output: summaryLines.join("\n"),
    artifacts: [
      {
        name: "results.csv",
        content: toCsv(
          ["target_tokens", "trial", "prompt_tokens", "prefill_tps", "decode_tps", "elapsed_ms"],
          csvRows,
        ),
      },
    ],
    medianDecodeTps: r1(median(allDecodeMedians)),
  };
}
