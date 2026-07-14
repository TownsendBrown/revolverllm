/** Heuristic: model ids/paths that typically expose chat-template thinking. */
const REASONING_MODEL_RE =
  /qwen3|qwq|deepseek-r1|deepseek.?reason|gemma-?4|gemma4|magistral|phi-4-reasoning|hunyuan|seed-thinking|glm-4\.5|glm4\.5|minimax-m1|gpt-oss|openai-gpt-oss|r1-|thinking/i;

/** Markers in Jinja / chat templates that indicate thinking support. */
const TEMPLATE_REASONING_RE =
  /enable_thinking|<think>|<\/think>|<\|think\|>|<\|\/think\|>|reasoning_content|reasoning_effort|thinking/i;

/** True when the loaded model is likely to honor enable_thinking / reasoning traces. */
export function modelLikelySupportsReasoning(
  ...hints: Array<string | null | undefined>
): boolean {
  return hints.some((h) => Boolean(h && REASONING_MODEL_RE.test(h)));
}

/**
 * Detect reasoning from llama-server `GET /props` fields.
 * Returns null when there is nothing to inspect (caller should fall back).
 */
export function chatTemplateSupportsReasoning(
  chatTemplate: string | null | undefined,
  caps?: Record<string, unknown> | null,
): boolean | null {
  if (caps && typeof caps === "object") {
    for (const [key, value] of Object.entries(caps)) {
      if (/reason|think/i.test(key) && value === true) return true;
    }
  }
  if (chatTemplate == null || chatTemplate === "") return null;
  return TEMPLATE_REASONING_RE.test(chatTemplate);
}

/** Prefer live /props detection; fall back to model-name heuristic. */
export function resolveSupportsReasoning(opts: {
  fromProps: boolean | null | undefined;
  hints?: Array<string | null | undefined>;
}): boolean {
  if (opts.fromProps === true) return true;
  if (opts.fromProps === false) return false;
  return modelLikelySupportsReasoning(...(opts.hints ?? []));
}

/** Split inline `<think>…</think>` (and common variants) out of assistant text. */
export function splitThinkTags(text: string): { content: string; reasoning: string } {
  if (!text) return { content: "", reasoning: "" };

  const blocks: string[] = [];
  const content = text
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
      blocks.push(String(inner).trim());
      return "";
    })
    .replace(/<\|think\|>([\s\S]*?)<\|\/think\|>/gi, (_m, inner: string) => {
      blocks.push(String(inner).trim());
      return "";
    })
    .replace(/^\s+/, "")
    .trimStart();

  return {
    content: content.trim() ? content : text.includes("<think") ? "" : text,
    reasoning: blocks.filter(Boolean).join("\n\n"),
  };
}

/** Rough token estimate when the server has not reported usage yet. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
