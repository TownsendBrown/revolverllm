/**
 * Low-level, non-streaming chat access for benchmark suites. Unlike the
 * interactive chat path this exposes temperature, seed, max_tokens, tools,
 * and prompt-cache control, and returns raw server timings.
 */

export interface BenchTarget {
  host: string;
  port: number;
  model: string;
  apiKey: string | null;
}

export interface RawToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ChatOnceResult {
  content: string;
  /** Separated thinking output (gpt-oss/Harmony `reasoning_content`), if any. */
  reasoning: string | null;
  /** "stop", "length", … — "length" means the answer was cut off. */
  finishReason: string | null;
  toolCalls: RawToolCall[];
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  timings: {
    prompt_n?: number;
    prompt_ms?: number;
    prompt_per_second?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
  } | null;
  elapsedMs: number;
}

export interface ChatOnceOptions {
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  tools?: unknown[];
  /** llama.cpp extension — disable prompt caching for honest prefill timing. */
  cachePrompt?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type ChatMessage = Record<string, unknown>;

export async function chatOnce(
  target: BenchTarget,
  messages: ChatMessage[],
  opts: ChatOnceOptions = {},
): Promise<ChatOnceResult> {
  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0,
    seed: opts.seed ?? 42,
  };
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.tools) body.tools = opts.tools;
  if (opts.cachePrompt != null) body.cache_prompt = opts.cachePrompt;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 300_000);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  const startMs = Date.now();
  try {
    const res = await fetch(`http://${target.host}:${target.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`chat/completions ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          reasoning?: string | null;
          tool_calls?: RawToolCall[];
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      timings?: ChatOnceResult["timings"];
    };
    const choice = json.choices?.[0];
    const message = choice?.message;
    return {
      content: message?.content ?? "",
      reasoning: message?.reasoning_content ?? message?.reasoning ?? null,
      finishReason: choice?.finish_reason ?? null,
      toolCalls: message?.tool_calls ?? [],
      usage: json.usage ?? null,
      timings: json.timings ?? null,
      elapsedMs: Date.now() - startMs,
    };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export interface GenerationProbe {
  ok: boolean;
  /** Why the target is unfit for a coding benchmark, when `ok` is false. */
  reason: string | null;
  contentChars: number;
  reasoningChars: number;
  finishReason: string | null;
  completionTokens: number | null;
  elapsedMs: number;
}

const PROBE_PROMPT =
  "Please provide a self-contained Python script that solves the following problem in a " +
  "markdown code block:\n```python\ndef add(a: int, b: int) -> int:\n    " +
  '"""Return the sum of a and b."""\n```';

/**
 * One cheap request that answers "will a 30-minute coding benchmark produce
 * anything?". Reasoning models routinely spend the whole budget thinking and
 * return empty content, which downstream harnesses score as 0% rather than as a
 * broken run.
 */
export async function probeGeneration(
  target: BenchTarget,
  opts: { maxTokens: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<GenerationProbe> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    try {
      const result = await chatOnce(target, [{ role: "user", content: PROBE_PROMPT }], {
        temperature: 0,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        timeoutMs,
      });

      const content = result.content.trim();
      const reasoning = result.reasoning?.trim() ?? "";
      const probe: GenerationProbe = {
        ok: true,
        reason: null,
        contentChars: content.length,
        reasoningChars: reasoning.length,
        finishReason: result.finishReason,
        completionTokens: result.usage?.completion_tokens ?? null,
        elapsedMs: result.elapsedMs,
      };

      if (!content) {
        probe.ok = false;
        probe.reason = reasoning
          ? `Model returned ${reasoning.length} chars of reasoning and no answer within ` +
            `${opts.maxTokens} tokens — raise the token budget or disable thinking.`
          : "Model returned empty content — check the server logs and the model's chat template.";
      } else if (result.finishReason === "length" && !content.includes("```")) {
        probe.ok = false;
        probe.reason =
          `Answer was truncated at ${opts.maxTokens} tokens before producing a code block — ` +
          "raise the token budget.";
      }

      // Empty answer is definitive — don't retry. Transport blips are.
      return probe;
    } catch (e) {
      lastError = e;
      if (attempt === 1 && !opts.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Preflight chat failed: ${String(lastError)}`);
}

/**
 * Count tokens using the server tokenizer (llama.cpp POST /tokenize).
 * Returns null when the endpoint is unavailable (e.g. vLLM without it).
 */
export async function countTokens(target: BenchTarget, text: string): Promise<number | null> {
  try {
    const res = await fetch(`http://${target.host}:${target.port}/tokenize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tokens?: unknown[] };
    return Array.isArray(json.tokens) ? json.tokens.length : null;
  } catch {
    return null;
  }
}

/** Heuristic fallback when the server tokenizer is unavailable. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Pad `base` with repetitions of `filler` until it reaches ~`targetTokens`
 * (within 2%), preferring the server tokenizer for exact counts. This mirrors
 * controlled-context-size prompt construction: comparisons across runs and
 * models stay reproducible because prompt sizes are token-exact, not
 * character-approximate.
 */
export async function padToTokenCount(
  target: BenchTarget,
  base: string,
  filler: string,
  targetTokens: number,
): Promise<{ text: string; tokens: number; exact: boolean }> {
  const count = async (text: string) => (await countTokens(target, text)) ?? estimateTokenCount(text);
  const exact = (await countTokens(target, filler)) != null;

  let text = base;
  let tokens = await count(text);
  const fillerTokens = Math.max(1, await count(filler));

  // Coarse fill, then trim/extend in smaller steps.
  for (let i = 0; i < 12 && tokens < targetTokens * 0.98; i++) {
    const deficit = targetTokens - tokens;
    const reps = Math.max(1, Math.floor((deficit / fillerTokens) * 0.9));
    text += ` ${Array(reps).fill(filler).join(" ")}`;
    tokens = await count(text);
  }
  while (tokens > targetTokens && text.length > base.length) {
    const overshootChars = Math.ceil((tokens - targetTokens) * 4);
    text = text.slice(0, Math.max(base.length, text.length - overshootChars));
    tokens = await count(text);
  }
  return { text, tokens, exact };
}

export function median(values: number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";
}
