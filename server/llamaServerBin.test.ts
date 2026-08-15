import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extraLlamaServerCandidates, probeNativeRuntime, resolveLlamaServerBin } from "./llamaServerBin";

describe("resolveLlamaServerBin", () => {
  it("accepts an explicit executable override", () => {
    const found = resolveLlamaServerBin(process.execPath);
    assert.equal(found.bin, process.execPath);
  });

  it("lists ~/.local/bin and LM Studio extras under HOME", () => {
    const extra = extraLlamaServerCandidates("/tmp/revolver-home");
    assert.ok(extra.some((p) => p.endsWith(".local/bin/llama-server")));
    assert.ok(extra.every((p) => !p.includes("lmstudio-cuda-volta-patch")));
  });

  it("does not scan CUDA packs on darwin", () => {
    const found = resolveLlamaServerBin(undefined, { skipPacks: false, platform: "darwin", pack: null });
    assert.equal(found.packId, undefined);
  });
});

describe("probeNativeRuntime", () => {
  it("disables native inside Compose", () => {
    const prev = process.env.REVOLVER_COMPOSE;
    process.env.REVOLVER_COMPOSE = "1";
    try {
      const probe = probeNativeRuntime(process.execPath);
      assert.equal(probe.available, false);
      assert.match(probe.error ?? "", /Compose/);
    } finally {
      if (prev == null) delete process.env.REVOLVER_COMPOSE;
      else process.env.REVOLVER_COMPOSE = prev;
    }
  });

  it("reports available when a binary exists outside Compose", () => {
    const prev = process.env.REVOLVER_COMPOSE;
    delete process.env.REVOLVER_COMPOSE;
    try {
      const probe = probeNativeRuntime(process.execPath);
      assert.equal(probe.available, true);
      assert.equal(probe.bin, process.execPath);
    } finally {
      if (prev != null) process.env.REVOLVER_COMPOSE = prev;
    }
  });
});
