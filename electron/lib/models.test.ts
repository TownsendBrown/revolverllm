import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { after, describe, it } from "node:test";
import { scanGgufUnderRoots } from "./models";
import { joinRepoDownloadDir } from "./paths";

const tmp = mkdtempSync(join(tmpdir(), "revolver-models-scan-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("joinRepoDownloadDir", () => {
  it("puts GGUF and MLX under owner/name on the same root", () => {
    const models = "/Users/x/Library/Application Support/Revolver/models";
    assert.equal(
      joinRepoDownloadDir(models, "lmstudio-community/gemma-3-1b-it-GGUF"),
      join(models, "lmstudio-community", "gemma-3-1b-it-GGUF"),
    );
    assert.equal(
      joinRepoDownloadDir(models, "lmstudio-community/LFM2.5-1.2B-Instruct-MLX-8bit"),
      join(models, "lmstudio-community", "LFM2.5-1.2B-Instruct-MLX-8bit"),
    );
  });

  it("rejects empty repo id", () => {
    assert.throws(() => joinRepoDownloadDir("/models", ""), /Invalid repo id/);
  });
});

describe("scanGgufUnderRoots", () => {
  it("finds GGUF files in hub even when models dir is empty", () => {
    const modelsDir = join(tmp, "models");
    const hubDir = join(tmp, "hub", "models");
    mkdirSync(modelsDir, { recursive: true });
    const ggufDir = join(hubDir, "lmstudio-community", "gemma-3-1b-it-GGUF");
    mkdirSync(ggufDir, { recursive: true });
    const ggufPath = join(ggufDir, "gemma-3-1b-it-Q4_K_M.gguf");
    writeFileSync(ggufPath, "gguf");

    const found = scanGgufUnderRoots([modelsDir, hubDir]);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, ggufPath);
    assert.equal(found[0].relPath, "lmstudio-community/gemma-3-1b-it-GGUF/gemma-3-1b-it-Q4_K_M.gguf");
  });

  it("dedupes when hub is nested under models", () => {
    const modelsDir = join(tmp, "nested-models");
    const hubDir = join(modelsDir, "hub");
    const ggufDir = join(hubDir, "org", "model");
    mkdirSync(ggufDir, { recursive: true });
    const ggufPath = join(ggufDir, "w.gguf");
    writeFileSync(ggufPath, "gguf");

    const found = scanGgufUnderRoots([modelsDir, hubDir]);
    assert.equal(found.length, 1);
    assert.equal(found[0].path, ggufPath);
  });

  it("skips mmproj sidecars as catalog entries", () => {
    const root = join(tmp, "mmproj-root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "model.gguf"), "gguf");
    writeFileSync(join(root, "mmproj-f16.gguf"), "mm");

    const found = scanGgufUnderRoots([root]);
    assert.equal(found.length, 1);
    assert.equal(found[0].relPath, "model.gguf");
    assert.equal(found[0].visionPath, join(root, "mmproj-f16.gguf"));
  });
});
