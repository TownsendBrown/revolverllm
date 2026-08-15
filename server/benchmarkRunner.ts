import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";
import { inferChatStream } from "../electron/lib/chatInfer";
import { allBenchmarkIds, getBenchmarkDefinition } from "../shared/benchmarks/definitions";
import { evaluateBenchmarkOutput, scoreFromChecks } from "../shared/benchmarks/evaluators";
import { runAgencySuite } from "./benchmarkAgency";
import type { BenchTarget } from "./benchmarkChat";
import { runEvalPlusSuite } from "./benchmarkEvalPlus";
import { runLiveCodeBenchSuite } from "./benchmarkLiveCodeBench";
import { derivePreviewChecks, runPreviewSmokeCheck } from "./benchmarkPreview";
import { runPerformanceSuite } from "./benchmarkPerformance";
import { runRetrievalSuite } from "./benchmarkRetrieval";
import { modelUsesHarmonyChannels, splitAssistantOutput } from "../shared/reasoning";
import type {
  BenchmarkCategory,
  BenchmarkRun,
  BenchmarkRunConfig,
  BenchmarkTestResult,
  StartBenchmarkRequest,
} from "../shared/benchmarks/types";
import * as store from "./benchmarkStore";
import { serverManager } from "./serverManager";

const activeRuns = new Map<string, AbortController>();

function emptyTestResult(testId: BenchmarkCategory): BenchmarkTestResult {
  const def = getBenchmarkDefinition(testId)!;
  return {
    testId,
    definitionVersion: def.version,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    output: null,
    reasoning: null,
    automatedScore: null,
    automatedMaxScore: null,
    checks: [],
    humanScore: null,
    humanMaxScore: def.supportsHumanEval ? 10 : null,
    humanNotes: null,
    combinedScore: null,
    error: null,
    artifacts: [],
    metrics: null,
  };
}

function combinedScore(result: BenchmarkTestResult): number | null {
  const auto = result.automatedScore;
  const autoMax = result.automatedMaxScore;
  const human = result.humanScore;
  const humanMax = result.humanMaxScore;
  if (auto == null) return null;
  const autoNorm = autoMax && autoMax > 0 ? auto / autoMax : 0;
  if (human == null || !humanMax || humanMax <= 0) return Math.round(autoNorm * 100);
  const humanNorm = human / humanMax;
  return Math.round(((autoNorm + humanNorm) / 2) * 100);
}

/** gpt-oss Harmony models may put the answer in content, reasoning, or inline channels. */
function effectiveModelOutput(
  content: string,
  reasoning: string | null | undefined,
  modelHints: Array<string | null | undefined>,
): { output: string; reasoning: string | null } {
  let out = content ?? "";
  let think = reasoning?.trim() ?? "";

  if (modelUsesHarmonyChannels(...modelHints) || /<\|channel\|>/i.test(out)) {
    const split = splitAssistantOutput(out);
    if (split.content.trim()) out = split.content;
    if (split.reasoning.trim()) {
      think = think ? `${think}\n\n${split.reasoning}` : split.reasoning;
    }
  }

  if (!out.trim() && think) out = think;
  return { output: out.trim(), reasoning: think || null };
}

interface SuiteOutcome {
  checks: BenchmarkTestResult["checks"];
  output: string;
  artifacts: Array<{ name: string; content: string }>;
  tokensPerSecond: number | null;
}

async function runSuite(
  testId: BenchmarkCategory,
  target: BenchTarget,
  contextLength: number | null,
  signal: AbortSignal,
  onProgress?: (tail: string) => void,
): Promise<SuiteOutcome> {
  switch (testId) {
    case "performance": {
      const r = await runPerformanceSuite(target, contextLength, signal);
      return { checks: r.checks, output: r.output, artifacts: r.artifacts, tokensPerSecond: r.medianDecodeTps };
    }
    case "context-retrieval": {
      const r = await runRetrievalSuite(target, contextLength, signal);
      return { checks: r.checks, output: r.output, artifacts: r.artifacts, tokensPerSecond: null };
    }
    case "agency": {
      const r = await runAgencySuite(target, signal);
      return { checks: r.checks, output: r.output, artifacts: r.artifacts, tokensPerSecond: null };
    }
    case "livecodebench": {
      const r = await runLiveCodeBenchSuite(target, signal, onProgress);
      return { checks: r.checks, output: r.output, artifacts: r.artifacts, tokensPerSecond: null };
    }
    case "evalplus": {
      const r = await runEvalPlusSuite(target, signal, onProgress);
      return { checks: r.checks, output: r.output, artifacts: r.artifacts, tokensPerSecond: null };
    }
    default:
      throw new Error(`No suite runner for benchmark "${testId}"`);
  }
}

function extractHtmlArtifact(output: string, testId: BenchmarkCategory): string | null {
  if (
    testId !== "website-generation" &&
    testId !== "platformer-game" &&
    testId !== "frontend-design"
  ) {
    return null;
  }
  let text = output.trim();
  text = text.replace(/^```(?:html)?\s*\n?/im, "").replace(/\n?```\s*$/im, "");
  if (/<!doctype\s+html/i.test(text) || /<html[\s>]/i.test(text)) return text;
  return null;
}

async function runSingleTest(
  run: BenchmarkRun,
  testId: BenchmarkCategory,
  config: BenchmarkRunConfig,
  signal: AbortSignal,
): Promise<void> {
  const def = getBenchmarkDefinition(testId);
  if (!def) return;

  const startedAt = new Date().toISOString();
  store.updateTestResult(run.id, testId, { status: "running", startedAt });

  const target = await serverManager.inferTarget(config.serverId);
  const loaded = serverManager.getLoaded(config.serverId);
  const t0 = Date.now();

  try {
    if (signal.aborted) throw new Error("Cancelled");

    if (def.kind === "suite") {
      const benchTarget: BenchTarget = {
        host: target.host,
        port: target.port,
        model: target.model,
        apiKey: target.apiKey,
      };
      const ctxLen = loaded?.contextLength ?? config.contextLength;
      const suite = await runSuite(testId, benchTarget, ctxLen, signal, (tail) => {
        store.updateTestResult(run.id, testId, {
          status: "running",
          startedAt,
          output: `Running… (${Math.round((Date.now() - t0) / 1000)}s)\n\n--- container log (tail) ---\n${tail}`,
          metrics: {
            promptTokens: null,
            completionTokens: null,
            tokensPerSecond: null,
            ttftMs: null,
            elapsedMs: Date.now() - t0,
          },
        });
      });

      const artifacts: string[] = [];
      for (const a of suite.artifacts) {
        store.writeArtifact(run.id, testId, a.name, a.content);
        artifacts.push(`${testId}/${a.name}`);
      }
      const { score, max } = scoreFromChecks(suite.checks);
      const merged = {
        ...emptyTestResult(testId),
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        output: suite.output,
        automatedScore: score,
        automatedMaxScore: max,
        checks: suite.checks,
        artifacts,
        metrics: {
          promptTokens: null,
          completionTokens: null,
          tokensPerSecond: suite.tokensPerSecond,
          ttftMs: null,
          elapsedMs: Date.now() - t0,
        },
      } as BenchmarkTestResult;
      merged.combinedScore = combinedScore(merged);
      store.updateTestResult(run.id, testId, merged);
      return;
    }

    if (!def.prompt) throw new Error(`Benchmark "${testId}" has no prompt`);

    const result = await inferChatStream(
      [{ role: "user", content: def.prompt }],
      {
        ...target,
        enableThinking: config.enableThinking,
        contextLength: loaded?.contextLength ?? config.contextLength,
        modelHints: [loaded?.modelId, loaded?.modelPath, config.modelDisplayName],
        onDelta: () => {},
      },
    );

    if (signal.aborted) throw new Error("Cancelled");

    const modelHints = [loaded?.modelId, loaded?.modelPath, config.modelDisplayName, config.modelId];
    const { output, reasoning } = effectiveModelOutput(
      result.content ?? "",
      result.reasoning,
      modelHints,
    );
    const evalResult = evaluateBenchmarkOutput(testId, output);
    let checks = evalResult.checks;
    const artifacts: string[] = [];

    store.writeArtifact(run.id, testId, "output.txt", output);
    artifacts.push(`${testId}/output.txt`);

    if (reasoning) {
      store.writeArtifact(run.id, testId, "reasoning.txt", reasoning);
      artifacts.push(`${testId}/reasoning.txt`);
    }

    const html = extractHtmlArtifact(output, testId);
    if (html) {
      store.writeArtifact(run.id, testId, "index.html", html);
      artifacts.push(`${testId}/index.html`);
    }

    // Confirm the generated game actually runs in the preview pane.
    if (testId === "platformer-game") {
      const preview = html
        ? await runPreviewSmokeCheck(html)
        : {
            checks: derivePreviewChecks({
              scripts: 0,
              contextRequests: 0,
              drawOps: 0,
              framesRendered: 0,
              frameCallbacks: 0,
              keyListeners: 0,
              respondedToInput: false,
              deterministic: false,
              errors: [{ phase: "script", message: "output contained no HTML document to preview" }],
            }),
            log: "",
          };
      checks = [...checks, ...preview.checks];
      if (preview.log) {
        store.writeArtifact(run.id, testId, "preview-check.log", preview.log);
        artifacts.push(`${testId}/preview-check.log`);
      }
    }

    const { score: automatedScore, max: automatedMaxScore } = scoreFromChecks(checks);

    const testResult: Partial<BenchmarkTestResult> = {
      status: "completed",
      startedAt,
      finishedAt: new Date().toISOString(),
      output,
      reasoning,
      automatedScore,
      automatedMaxScore,
      checks,
      artifacts,
      metrics: {
        promptTokens: result.metrics?.promptTokens ?? result.usage?.prompt_tokens ?? null,
        completionTokens: result.metrics?.completionTokens ?? result.usage?.completion_tokens ?? null,
        tokensPerSecond: result.metrics?.tokensPerSecond ?? null,
        ttftMs: result.metrics?.ttftMs ?? null,
        elapsedMs: Date.now() - t0,
      },
    };
    const merged = { ...emptyTestResult(testId), ...testResult } as BenchmarkTestResult;
    merged.combinedScore = combinedScore(merged);
    store.updateTestResult(run.id, testId, merged);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.updateTestResult(run.id, testId, {
      status: signal.aborted ? "skipped" : "failed",
      finishedAt: new Date().toISOString(),
      error: message,
      metrics: {
        promptTokens: null,
        completionTokens: null,
        tokensPerSecond: null,
        ttftMs: null,
        elapsedMs: Date.now() - t0,
      },
    });
    // Keep going through the rest of the suite — one failure must not abort siblings.
  }
}

async function executeRun(run: BenchmarkRun, signal: AbortSignal): Promise<void> {
  const updated: BenchmarkRun = {
    ...run,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  store.saveRun(updated);

  try {
    await serverManager.ensureReady(run.config.serverId);

    for (const testId of run.config.testIds) {
      if (signal.aborted) break;
      await runSingleTest(updated, testId, run.config, signal);
    }

    const finalRun = store.getRun(run.id);
    if (!finalRun) return;

    const failed = finalRun.results.some((r) => r.status === "failed");
    store.saveRun({
      ...finalRun,
      status: signal.aborted ? "cancelled" : failed ? "failed" : "completed",
      finishedAt: new Date().toISOString(),
      error: failed ? "One or more tests failed" : null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const finalRun = store.getRun(run.id);
    if (finalRun) {
      store.saveRun({
        ...finalRun,
        status: signal.aborted ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        error: message,
      });
    }
  } finally {
    activeRuns.delete(run.id);
  }
}

export function listBenchmarkDefinitions() {
  return allBenchmarkIds().map((id) => getBenchmarkDefinition(id)!);
}

export function listBenchmarkRuns(): BenchmarkRun[] {
  return store.listRuns();
}

export function getBenchmarkRun(id: string): BenchmarkRun | null {
  return store.getRun(id);
}

export function deleteBenchmarkRun(id: string): void {
  const ctrl = activeRuns.get(id);
  if (ctrl) ctrl.abort();
  store.deleteRun(id);
}

export function cancelBenchmarkRun(id: string): void {
  const ctrl = activeRuns.get(id);
  if (ctrl) ctrl.abort();
  const run = store.getRun(id);
  if (run && run.status === "running") {
    store.saveRun({ ...run, status: "cancelled", finishedAt: new Date().toISOString() });
  }
}

export async function startBenchmarkRun(req: StartBenchmarkRequest): Promise<BenchmarkRun> {
  const serverId = req.serverId?.trim();
  if (!serverId) throw new Error("serverId required");

  const status = serverManager.getStatus(serverId);
  if (!status) throw new Error("Server not found");
  if (!status.running) throw new Error("Server is not running — start it before benchmarking");

  const loaded = status.loaded;
  const testIds = req.testIds?.length ? req.testIds : allBenchmarkIds();

  for (const id of testIds) {
    if (!getBenchmarkDefinition(id)) throw new Error(`Unknown benchmark: ${id}`);
  }

  const config: BenchmarkRunConfig = {
    serverId,
    modelId: loaded?.modelId ?? status.definition.modelId,
    modelDisplayName: loaded?.modelId?.split("/").pop() ?? status.definition.name,
    engineId: status.definition.engine ?? "llamacpp",
    backendId: status.definition.backend,
    contextLength: loaded?.contextLength ?? status.definition.contextLength,
    nGpuLayers: loaded?.nGpuLayers ?? status.definition.nGpuLayers,
    enableThinking: req.enableThinking === true,
    testIds,
  };

  const run: BenchmarkRun = {
    id: randomUUID(),
    status: "pending",
    config,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    results: testIds.map(emptyTestResult),
    error: null,
  };

  store.saveRun(run);
  const ctrl = new AbortController();
  activeRuns.set(run.id, ctrl);
  void executeRun(run, ctrl.signal);
  return run;
}

export function setHumanScore(
  runId: string,
  testId: BenchmarkCategory,
  humanScore: number,
  humanMaxScore?: number,
  humanNotes?: string,
): BenchmarkRun {
  const run = store.getRun(runId);
  if (!run) throw new Error("Run not found");
  const idx = run.results.findIndex((r) => r.testId === testId);
  if (idx < 0) throw new Error("Test not found in run");

  const result = { ...run.results[idx] };
  result.humanScore = humanScore;
  if (humanMaxScore != null) result.humanMaxScore = humanMaxScore;
  if (humanNotes != null) result.humanNotes = humanNotes;
  result.combinedScore = combinedScore(result);
  run.results[idx] = result;
  store.saveRun(run);
  return run;
}

export function getArtifactContent(runId: string, relPath: string): Buffer | null {
  return store.readArtifact(runId, relPath);
}

export function getArtifactFilePath(runId: string, relPath: string): string | null {
  return store.resolveArtifactPath(runId, relPath);
}

/** Write a small manifest for debugging — optional. */
export function writeRunManifest(run: BenchmarkRun): void {
  const dir = store.getRunArtifactsDir(run.id);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(run, null, 2) + "\n");
}
