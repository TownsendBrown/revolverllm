import type { BenchmarkCheckResult } from "../shared/benchmarks/types";
import {
  RETRIEVAL_DEPTHS,
  RETRIEVAL_TRIALS_PER_DEPTH,
  answerContainsPassphrase,
  buildHaystack,
  buildRetrievalPrompt,
  insertNeedle,
  makePassphrase,
  needleSentence,
} from "../shared/benchmarks/retrieval";
import { chatOnce, countTokens, estimateTokenCount, toCsv, type BenchTarget } from "./benchmarkChat";

/** Practical ceiling so huge context windows don't make the test take hours. */
export const RETRIEVAL_HAYSTACK_CAP_TOKENS = 16_384;
/** Headroom for chat template, question, and the answer itself. */
const RESERVE_TOKENS = 768;

export interface RetrievalSuiteResult {
  checks: BenchmarkCheckResult[];
  output: string;
  artifacts: Array<{ name: string; content: string }>;
  totalPassed: number;
  totalTrials: number;
}

export async function runRetrievalSuite(
  target: BenchTarget,
  contextLength: number | null,
  signal: AbortSignal,
): Promise<RetrievalSuiteResult> {
  const ctx = contextLength && contextLength > 0 ? contextLength : 4096;
  const haystackTokens = Math.min(ctx - RESERVE_TOKENS, RETRIEVAL_HAYSTACK_CAP_TOKENS);
  if (haystackTokens < 256) {
    throw new Error(`Context window ${ctx} too small for retrieval test (need ≥ ${256 + RESERVE_TOKENS})`);
  }

  // Size the haystack in characters, calibrated against the server tokenizer
  // on a sample so the fill fraction is consistent across models.
  const sample = buildHaystack(4000);
  const sampleTokens = (await countTokens(target, sample)) ?? estimateTokenCount(sample);
  const charsPerToken = sample.length / Math.max(1, sampleTokens);
  const haystack = buildHaystack(Math.floor(haystackTokens * charsPerToken));

  const checks: BenchmarkCheckResult[] = [];
  const csvRows: Array<Array<string | number | null>> = [];
  let totalPassed = 0;
  let totalTrials = 0;

  const summaryLines: string[] = [
    `Needle-in-a-haystack retrieval — haystack ≈${haystackTokens} tokens (context ${ctx}).`,
    `Settings: temperature 0, seed 42, ${RETRIEVAL_TRIALS_PER_DEPTH} trials per depth.`,
    "",
    "| Depth | Trials passed |",
    "|---|---|",
  ];

  for (const depth of RETRIEVAL_DEPTHS) {
    let depthPassed = 0;
    const failures: string[] = [];

    for (let trial = 0; trial < RETRIEVAL_TRIALS_PER_DEPTH; trial++) {
      if (signal.aborted) throw new Error("Cancelled");
      const passphrase = makePassphrase(depth, trial);
      const doc = insertNeedle(haystack, needleSentence(passphrase), depth);
      const prompt = buildRetrievalPrompt(doc);
      totalTrials++;

      try {
        // Generous budget: reasoning models spend tokens thinking before the
        // final channel; a tight cap truncates the run mid-reasoning.
        const res = await chatOnce(
          target,
          [{ role: "user", content: prompt }],
          { temperature: 0, seed: 42, maxTokens: 1024, signal },
        );
        // Grade the final answer; fall back to reasoning text only when the
        // model produced no final channel at all.
        const answer = res.content.trim() || (res.reasoning ?? "");
        const passed = answerContainsPassphrase(answer, passphrase);
        if (passed) {
          depthPassed++;
          totalPassed++;
        } else {
          failures.push(`trial ${trial + 1}: expected "${passphrase}", got "${answer.trim().slice(0, 60)}"`);
        }
        csvRows.push([depth, trial + 1, passphrase, passed ? 1 : 0, answer.trim().slice(0, 120)]);
      } catch (e) {
        if (signal.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`trial ${trial + 1}: request failed: ${msg.slice(0, 100)}`);
        csvRows.push([depth, trial + 1, passphrase, 0, `ERROR: ${msg.slice(0, 120)}`]);
      }
    }

    summaryLines.push(`| ${depth}% | ${depthPassed}/${RETRIEVAL_TRIALS_PER_DEPTH} |`);
    checks.push({
      id: `depth-${depth}`,
      label: `Retrieval at ${depth}% depth`,
      passed: depthPassed >= 2,
      detail:
        depthPassed >= 2
          ? `${depthPassed}/${RETRIEVAL_TRIALS_PER_DEPTH} trials correct`
          : `${depthPassed}/${RETRIEVAL_TRIALS_PER_DEPTH} trials correct — ${failures[0] ?? ""}`,
    });
  }

  summaryLines.push("", `Overall: ${totalPassed}/${totalTrials} trials correct.`);

  return {
    checks,
    output: summaryLines.join("\n"),
    artifacts: [
      {
        name: "results.csv",
        content: toCsv(["depth_percent", "trial", "passphrase", "passed", "answer"], csvRows),
      },
    ],
    totalPassed,
    totalTrials,
  };
}
