import { generationTracker } from "./generation";
import { splitThinkTags } from "../../shared/reasoning";
import type { EngineId, StreamDelta } from "../../shared/types";

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
};

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

/** Build metrics, server timings first, then usage+wallclock, then char heuristic. */
function buildMetrics(opts: {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: LlamaTimings;
  content: string;
  genElapsedMs: number | null;
  ttftMs: number | null;
}): InferMetrics {
  const { usage, timings, content, genElapsedMs, ttftMs } = opts;

  const promptTokens = usage?.prompt_tokens ?? timings?.prompt_n ?? null;
  const completionTokens =
    usage?.completion_tokens ??
    timings?.predicted_n ??
    (content ? Math.ceil(content.length / 4) : null);

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
      reasoning += parsed.reasoning;
      chunk.reasoning = parsed.reasoning;
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

  // Fallback: some servers leave thoughts inline in content when format=none.
  if (!reasoning && /<think|<\|think\|/i.test(content)) {
    const split = splitThinkTags(content);
    content = split.content;
    reasoning = split.reasoning;
  }

  const ttftMs = firstTokenAt != null ? firstTokenAt - startMs : null;
  const genElapsedMs = firstTokenAt != null ? Date.now() - firstTokenAt : null;
  const metrics = buildMetrics({ usage, timings, content, genElapsedMs, ttftMs });

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
        max_tokens: 2048,
        // Ask llama.cpp for the trailing usage chunk; it also attaches `timings`.
        stream_options: { include_usage: true },
        // Per-request thinking (Qwen3 / DeepSeek / Gemma templates).
        chat_template_kwargs: { enable_thinking: enableThinking },
        // Some OpenAI-compat stacks accept this alias.
        enable_thinking: enableThinking,
      }),
    });
    opts.markActivity?.();
    if (!res.ok) {
      const text = await res.text();
      generationTracker.fail(text);
      throw new Error(text);
    }
    if (!res.body) throw new Error("No response body from llama-server");

    const result = await readSseStream(res.body, opts.onDelta, startMs);
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
