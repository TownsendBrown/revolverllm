import { generationTracker } from "./generation";
import { estimateTokens, modelUsesHarmonyChannels, splitAssistantOutput } from "../../shared/reasoning";
import type { EngineId, StreamDelta } from "../../shared/types";
import { DEFAULT_CONTEXT_LENGTH } from "./contextLength";

export type InferTarget = {
  host: string;
  port: number;
  /** OpenAI `model` field — llama.cpp uses `local`; vLLM uses `/v1/models` id. */
  model?: string;
  /** When set, sent as `Authorization: Bearer <key>` so test-chat reaches keyed containers. */
  apiKey?: string | null;
  markActivity?: () => void;
  /** Per-request thinking toggle (chat_template_kwargs.enable_thinking). */
  enableThinking?: boolean;
  /** Model id/path hints — used to pick Harmony vs enable_thinking semantics. */
  modelHints?: Array<string | null | undefined>;
  /** Server context window — used to size max_tokens from remaining headroom. */
  contextLength?: number | null;
};

/** Rough prompt size for max_tokens budgeting (template overhead included). */
function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

/** Leave room for the prompt; always request at least 256 completion tokens. */
export function computeMaxTokens(
  messages: Array<{ role: string; content: string }>,
  contextLength?: number | null,
): number {
  const ctx = contextLength && contextLength > 0 ? contextLength : DEFAULT_CONTEXT_LENGTH;
  const prompt = estimatePromptTokens(messages);
  const available = ctx - prompt - 64;
  return Math.max(256, available);
}

/** Resolve the OpenAI model name for chat/completions. */
export async function resolveInferenceModel(
  host: string,
  port: number,
  apiKey: string | null,
  engine: EngineId | string,
): Promise<string> {
  if (engine === "llamacpp") return "local";

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`http://${host}:${port}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Inference server /v1/models failed: ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const id = body.data?.[0]?.id;
  if (!id) throw new Error("Inference server has no registered model");
  return id;
}

/** Detailed per-generation metrics, preferring server-reported llama.cpp timings. */
export interface InferMetrics {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Generation (decode) speed, tokens/sec. */
  tokensPerSecond: number | null;
  /** Prompt eval (prefill) speed, tokens/sec. */
  promptTokensPerSecond: number | null;
  /** Time to first token, ms. */
  ttftMs: number | null;
}

export type InferResult = {
  content: string;
  reasoning: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  metrics?: InferMetrics;
};

/** llama.cpp server `timings` object (non-standard OpenAI extension). */
interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
}

interface ChunkParse {
  content: string | null;
  reasoning: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: LlamaTimings;
}

function pickReasoning(
  delta?: { reasoning_content?: string; reasoning?: string },
  message?: { reasoning_content?: string; reasoning?: string },
): string | null {
  return (
    delta?.reasoning_content ??
    delta?.reasoning ??
    message?.reasoning_content ??
    message?.reasoning ??
    null
  );
}

function parseSseChunk(line: string): ChunkParse | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      timings?: LlamaTimings;
    };
    const choice = json.choices?.[0];
    return {
      content: choice?.delta?.content ?? choice?.message?.content ?? null,
      reasoning: pickReasoning(choice?.delta, choice?.message),
      usage: json.usage,
      timings: json.timings,
    };
  } catch {
    return null;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** OpenAI-compat thinking kwargs — Harmony models must not receive enable_thinking:false. */
export function buildThinkingRequestParams(
  enableThinking: boolean,
  ...modelHints: Array<string | null | undefined>
): Record<string, unknown> {
  const harmony = modelUsesHarmonyChannels(...modelHints);
  if (harmony) {
    return enableThinking
      ? { chat_template_kwargs: { enable_thinking: true }, enable_thinking: true }
      : {};
  }
  return {
    chat_template_kwargs: { enable_thinking: enableThinking },
    enable_thinking: enableThinking,
  };
}

/** Build metrics, server timings first, then usage+wallclock, then char heuristic. */
function buildMetrics(opts: {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: LlamaTimings;
  content: string;
  reasoning?: string;
  genElapsedMs: number | null;
  ttftMs: number | null;
}): InferMetrics {
  const { usage, timings, content, reasoning, genElapsedMs, ttftMs } = opts;

  const promptTokens = usage?.prompt_tokens ?? timings?.prompt_n ?? null;
  const textLen = content.length + (reasoning?.length ?? 0);
  let completionTokens =
    usage?.completion_tokens ??
    timings?.predicted_n ??
    (textLen > 0 ? Math.ceil(textLen / 4) : null);
  // gpt-oss may report completion_tokens=0 when output went to reasoning_content only.
  if ((completionTokens == null || completionTokens === 0) && textLen > 0) {
    completionTokens = Math.ceil(textLen / 4);
  }

  let tokensPerSecond: number | null = null;
  if (timings?.predicted_per_second != null) {
    tokensPerSecond = round1(timings.predicted_per_second);
  } else if (completionTokens != null && genElapsedMs != null && genElapsedMs > 0) {
    tokensPerSecond = round1((completionTokens / genElapsedMs) * 1000);
  }

  let promptTokensPerSecond: number | null = null;
  if (timings?.prompt_per_second != null) {
    promptTokensPerSecond = round1(timings.prompt_per_second);
  } else if (promptTokens != null && timings?.prompt_ms != null && timings.prompt_ms > 0) {
    promptTokensPerSecond = round1((promptTokens / timings.prompt_ms) * 1000);
  }

  return {
    promptTokens,
    completionTokens,
    tokensPerSecond,
    promptTokensPerSecond,
    ttftMs: timings?.prompt_ms != null ? Math.round(timings.prompt_ms) : ttftMs,
  };
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: StreamDelta) => void,
  startMs: number,
  collectReasoning: boolean,
): Promise<InferResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";

  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let timings: LlamaTimings | undefined;
  let firstTokenAt: number | null = null;

  const consume = (line: string) => {
    const parsed = parseSseChunk(line);
    if (!parsed) return;
    if (parsed.usage) usage = parsed.usage;
    if (parsed.timings) timings = parsed.timings;
    const chunk: StreamDelta = {};
    if (parsed.reasoning) {
      if (firstTokenAt == null) firstTokenAt = Date.now();
      if (collectReasoning) {
        reasoning += parsed.reasoning;
        chunk.reasoning = parsed.reasoning;
      }
    }
    if (parsed.content) {
      if (firstTokenAt == null) firstTokenAt = Date.now();
      content += parsed.content;
      chunk.content = parsed.content;
    }
    if (chunk.content != null || chunk.reasoning != null) onDelta(chunk);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  if (buffer.trim()) consume(buffer);

  // Fallback: unparsed thoughts/channels inline in content (reasoning_format=none, etc.).
  if (collectReasoning && (!reasoning || /<\|channel\|>/i.test(content))) {
    const split = splitAssistantOutput(content);
    if (split.reasoning) {
      reasoning = reasoning ? `${reasoning}\n\n${split.reasoning}` : split.reasoning;
    }
    if (split.content || !reasoning) content = split.content;
  } else if (!collectReasoning && /<\|channel\|>/i.test(content)) {
    content = splitAssistantOutput(content).content;
  }

  const ttftMs = firstTokenAt != null ? firstTokenAt - startMs : null;
  const genElapsedMs = firstTokenAt != null ? Date.now() - firstTokenAt : null;
  const metrics = buildMetrics({ usage, timings, content, reasoning, genElapsedMs, ttftMs });

  return {
    content: content || (reasoning ? "" : "(no response)"),
    reasoning: reasoning || null,
    usage,
    metrics,
  };
}

export async function inferChatStream(
  messages: Array<{ role: string; content: string }>,
  opts: InferTarget & { onDelta: (delta: StreamDelta) => void },
): Promise<InferResult> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  generationTracker.start(lastUser);
  const startMs = Date.now();
  try {
    const enableThinking = opts.enableThinking === true;
    const maxTokens = computeMaxTokens(messages, opts.contextLength);
    const res = await fetch(`http://${opts.host}:${opts.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model ?? "local",
        messages,
        stream: true,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
        ...buildThinkingRequestParams(enableThinking, ...(opts.modelHints ?? [])),
      }),
    });
    opts.markActivity?.();
    if (!res.ok) {
      const text = await res.text();
      generationTracker.fail(text);
      throw new Error(text);
    }
    if (!res.body) throw new Error("No response body from llama-server");

    const result = await readSseStream(res.body, opts.onDelta, startMs, enableThinking);
    generationTracker.finish(result.metrics);
    return result;
  } catch (e) {
    generationTracker.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Non-streaming fallback. */
export async function inferChat(
  messages: Array<{ role: string; content: string }>,
  opts: InferTarget,
): Promise<InferResult> {
  return inferChatStream(messages, { ...opts, onDelta: () => {} });
}
