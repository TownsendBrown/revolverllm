import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { folderForOpen, hostPathsForDocker, resolveHostPath } from "./openPath";

const KEYS = [
  "REVOLVER_DOCKER",
  "REVOLVER_HOST_MODELS_DIR",
  "REVOLVER_MODELS_DIR",
  "REVOLVER_HUB_MODELS_DIR",
  "REVOLVER_LOCAL_ROOT",
] as const;

const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
for (const k of KEYS) saved[k] = process.env[k];

function restoreEnv() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

const electronCfg = {
  modelsDir: "/Users/x/Library/Application Support/Revolver/models",
  hubModelsDir: "/Users/x/Library/Application Support/Revolver/hub/models",
  localRoot: "/Users/x/Library/Application Support/Revolver",
};

const dockerCfg = {
  modelsDir: "/models",
  hubModelsDir: "/models/hub",
  localRoot: "/models/.revolver",
};

describe("resolveHostPath", () => {
  afterEach(restoreEnv);

  it("leaves Electron native hub paths alone when there is no container mount split", () => {
    process.env.REVOLVER_DOCKER = "1";
    process.env.REVOLVER_HOST_MODELS_DIR = electronCfg.modelsDir;
    delete process.env.REVOLVER_MODELS_DIR;
    process.env.REVOLVER_HUB_MODELS_DIR = electronCfg.hubModelsDir;
    process.env.REVOLVER_LOCAL_ROOT = electronCfg.localRoot;

    const hubModel = `${electronCfg.hubModelsDir}/org/model`;
    assert.equal(resolveHostPath(hubModel, electronCfg), hubModel);
    assert.equal(
      resolveHostPath(`${electronCfg.modelsDir}/foo.gguf`, electronCfg),
      `${electronCfg.modelsDir}/foo.gguf`,
    );
    assert.equal(hostPathsForDocker(electronCfg), undefined);
  });

  it("remaps container /models to the host bind in real Docker", () => {
    process.env.REVOLVER_DOCKER = "1";
    process.env.REVOLVER_MODELS_DIR = "/models";
    process.env.REVOLVER_HOST_MODELS_DIR = "/home/ape/models";
    process.env.REVOLVER_HUB_MODELS_DIR = "/models/hub";
    process.env.REVOLVER_LOCAL_ROOT = "/models/.revolver";

    assert.equal(resolveHostPath("/models/org/model", dockerCfg), "/home/ape/models/org/model");
    assert.equal(resolveHostPath("/models/hub/org/model", dockerCfg), "/home/ape/models/hub/org/model");
    assert.equal(hostPathsForDocker(dockerCfg)?.hubModelsDir, "/home/ape/models/hub");
  });

  it("does not remap when Docker env is unset", () => {
    delete process.env.REVOLVER_DOCKER;
    const p = `${electronCfg.hubModelsDir}/org/model`;
    assert.equal(resolveHostPath(p, electronCfg), p);
  });
});

describe("folderForOpen", () => {
  it("returns the parent directory for a file", () => {
    const file = fileURLToPath(new URL("../package.json", import.meta.url));
    assert.equal(folderForOpen(file), dirname(file));
  });
});
