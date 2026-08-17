import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultHubPickedFiles,
  isCompanionFile,
  mergeWithCompanions,
  mlxTokenizerPresent,
} from "./hubDownloadFiles";

const LFM_MLX = [
  ".gitattributes",
  "README.md",
  "chat_template.jinja",
  "config.json",
  "generation_config.json",
  "model.safetensors",
  "model.safetensors.index.json",
  "tokenizer.json",
  "tokenizer_config.json",
];

describe("defaultHubPickedFiles", () => {
  it("includes tokenizer sidecars for MLX safetensors repos", () => {
    const picked = defaultHubPickedFiles(LFM_MLX.map((path) => ({ path })));
    assert.ok(picked.includes("tokenizer.json"));
    assert.ok(picked.includes("tokenizer_config.json"));
    assert.ok(picked.includes("config.json"));
    assert.ok(picked.includes("model.safetensors"));
    assert.ok(picked.includes("chat_template.jinja"));
    assert.ok(!picked.includes("README.md"));
    assert.ok(!picked.includes(".gitattributes"));
  });

  it("does not default to first five files", () => {
    const picked = defaultHubPickedFiles(LFM_MLX.map((path) => ({ path })));
    assert.ok(picked.length > 5);
  });

  it("picks Q4_K_M GGUF plus mmproj companion", () => {
    const picked = defaultHubPickedFiles([
      { path: "model-Q8_0.gguf" },
      { path: "model-Q4_K_M.gguf" },
      { path: "model.mmproj-f16.gguf" },
      { path: "README.md" },
    ]);
    assert.deepEqual(picked, ["model-Q4_K_M.gguf", "model.mmproj-f16.gguf"]);
  });
});

describe("mergeWithCompanions", () => {
  it("adds tokenizer.json when user only picked weights", () => {
    const merged = mergeWithCompanions(LFM_MLX, ["model.safetensors"]);
    assert.ok(merged.includes("tokenizer.json"));
    assert.ok(merged.includes("tokenizer_config.json"));
    assert.ok(merged.includes("model.safetensors"));
    assert.ok(!merged.includes("README.md"));
  });
});

describe("isCompanionFile", () => {
  it("treats jinja chat templates as companions", () => {
    assert.equal(isCompanionFile("chat_template.jinja"), true);
    assert.equal(isCompanionFile("model.safetensors"), false);
  });
});

describe("mlxTokenizerPresent", () => {
  it("requires tokenizer.json for LFM-style dirs", () => {
    assert.equal(mlxTokenizerPresent(["config.json", "model.safetensors"]), false);
    assert.equal(mlxTokenizerPresent(["config.json", "tokenizer.json", "model.safetensors"]), true);
  });
});
