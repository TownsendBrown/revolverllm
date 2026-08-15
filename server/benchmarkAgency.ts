import type { BenchmarkCheckResult } from "../shared/benchmarks/types";
import {
  AGENCY_MAX_TOKENS_PER_ROUND,
  AGENCY_MAX_TOOL_ROUNDS,
  AGENCY_SCENARIOS,
  AGENCY_SYSTEM_PROMPT,
  AGENCY_TOOLS,
  createAgencyState,
  executeAgencyTool,
  type ToolCallRecord,
} from "../shared/benchmarks/agency";
import { chatOnce, type BenchTarget, type RawToolCall } from "./benchmarkChat";

export interface AgencySuiteResult {
  checks: BenchmarkCheckResult[];
  output: string;
  artifacts: Array<{ name: string; content: string }>;
  passed: number;
  total: number;
}

function parseArgs(call: RawToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface ScenarioTranscript {
  scenarioId: string;
  passed: boolean;
  detail: string | null;
  rounds: number;
  calls: ToolCallRecord[];
  finalText: string;
  error: string | null;
}

async function runScenario(
  target: BenchTarget,
  scenario: (typeof AGENCY_SCENARIOS)[number],
  signal: AbortSignal,
): Promise<ScenarioTranscript> {
  const state = createAgencyState();
  const calls: ToolCallRecord[] = [];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: AGENCY_SYSTEM_PROMPT },
    { role: "user", content: scenario.prompt },
  ];

  let finalText = "";
  let rounds = 0;

  for (; rounds < AGENCY_MAX_TOOL_ROUNDS; rounds++) {
    if (signal.aborted) throw new Error("Cancelled");
    const res = await chatOnce(target, messages, {
      temperature: 0,
      seed: 42,
      maxTokens: AGENCY_MAX_TOKENS_PER_ROUND,
      tools: AGENCY_TOOLS,
      signal,
    });

    if (res.toolCalls.length === 0) {
      finalText = res.content;
      break;
    }

    messages.push({
      role: "assistant",
      content: res.content || null,
      tool_calls: res.toolCalls,
    });
    for (const tc of res.toolCalls) {
      const args = parseArgs(tc);
      const { result, isError } = executeAgencyTool(state, tc.function.name, args);
      calls.push({ round: rounds + 1, name: tc.function.name, args, result, isError });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    // Keep any text the model emitted alongside its last tool calls as a
    // fallback final answer if it never sends a tool-free turn.
    if (res.content) finalText = res.content;
  }

  const verdict = scenario.expect({ calls, state, finalText });
  return {
    scenarioId: scenario.id,
    passed: verdict.passed,
    detail: verdict.detail ?? null,
    rounds,
    calls,
    finalText,
    error: null,
  };
}

export async function runAgencySuite(
  target: BenchTarget,
  signal: AbortSignal,
): Promise<AgencySuiteResult> {
  const checks: BenchmarkCheckResult[] = [];
  const transcripts: ScenarioTranscript[] = [];
  let passed = 0;

  const summaryLines: string[] = [
    `Agency benchmark — ${AGENCY_SCENARIOS.length} scenarios, ${AGENCY_TOOLS.length} tools, MiniCorp sandbox.`,
    `Settings: temperature 0, seed 42, max ${AGENCY_MAX_TOOL_ROUNDS} tool rounds, ` +
      `${AGENCY_MAX_TOKENS_PER_ROUND} tokens/round, sandbox clock 2026-05-28 10:00 UTC.`,
    "",
    "| Scenario | Skill | Result |",
    "|---|---|---|",
  ];

  for (const scenario of AGENCY_SCENARIOS) {
    if (signal.aborted) throw new Error("Cancelled");
    let transcript: ScenarioTranscript;
    try {
      transcript = await runScenario(target, scenario, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      transcript = {
        scenarioId: scenario.id,
        passed: false,
        detail: `request failed: ${msg.slice(0, 160)}`,
        rounds: 0,
        calls: [],
        finalText: "",
        error: msg,
      };
    }
    transcripts.push(transcript);
    if (transcript.passed) passed++;

    checks.push({
      id: scenario.id,
      label: `${scenario.name} (${scenario.skill})`,
      passed: transcript.passed,
      detail: transcript.passed ? undefined : (transcript.detail ?? undefined),
    });
    summaryLines.push(
      `| ${scenario.name} | ${scenario.skill} | ${transcript.passed ? "pass" : `fail — ${transcript.detail ?? "?"}`} |`,
    );
  }

  summaryLines.push("", `Overall: ${passed}/${AGENCY_SCENARIOS.length} scenarios passed.`);

  return {
    checks,
    output: summaryLines.join("\n"),
    artifacts: [{ name: "transcripts.json", content: JSON.stringify(transcripts, null, 2) + "\n" }],
    passed,
    total: AGENCY_SCENARIOS.length,
  };
}
