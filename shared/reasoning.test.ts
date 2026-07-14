import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatTemplateSupportsReasoning,
  modelLikelySupportsReasoning,
  resolveSupportsReasoning,
  splitThinkTags,
} from "./reasoning";

describe("modelLikelySupportsReasoning", () => {
  it("matches known reasoning model ids", () => {
    assert.equal(modelLikelySupportsReasoning("Qwen/Qwen3-8B"), true);
    assert.equal(modelLikelySupportsReasoning("deepseek-r1-distill-qwen"), true);
    assert.equal(modelLikelySupportsReasoning("google/gemma-4-9b"), true);
    assert.equal(modelLikelySupportsReasoning("llama-3.1-8b-instruct"), false);
  });
});

describe("chatTemplateSupportsReasoning", () => {
  it("detects enable_thinking in jinja", () => {
    assert.equal(
      chatTemplateSupportsReasoning("{% if enable_thinking %}...{% endif %}"),
      true,
    );
  });

  it("detects think tags", () => {
    assert.equal(chatTemplateSupportsReasoning("before <think> after"), true);
  });

  it("returns false for plain chatml", () => {
    assert.equal(
      chatTemplateSupportsReasoning("<|im_start|>user\n{{ content }}<|im_end|>"),
      false,
    );
  });

  it("returns null when template missing", () => {
    assert.equal(chatTemplateSupportsReasoning(null), null);
    assert.equal(chatTemplateSupportsReasoning(""), null);
  });

  it("honors caps flags", () => {
    assert.equal(
      chatTemplateSupportsReasoning("plain", { supports_preserve_reasoning: true }),
      true,
    );
  });
});

describe("resolveSupportsReasoning", () => {
  it("prefers props over name heuristic", () => {
    assert.equal(
      resolveSupportsReasoning({ fromProps: false, hints: ["Qwen3-8B"] }),
      false,
    );
    assert.equal(
      resolveSupportsReasoning({ fromProps: true, hints: ["llama-3.1"] }),
      true,
    );
    assert.equal(
      resolveSupportsReasoning({ fromProps: null, hints: ["Qwen3-8B"] }),
      true,
    );
  });
});

describe("splitThinkTags", () => {
  it("extracts think blocks and leaves the reply", () => {
    const { content, reasoning } = splitThinkTags(
      "<think>step one</think>\n\nFinal answer.",
    );
    assert.equal(reasoning, "step one");
    assert.match(content, /Final answer/);
  });

  it("returns empty content when only thinking was emitted", () => {
    const { content, reasoning } = splitThinkTags("<think>only thoughts</think>");
    assert.equal(reasoning, "only thoughts");
    assert.equal(content, "");
  });
});
