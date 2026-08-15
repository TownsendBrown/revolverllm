import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  claimedKeys,
  claimGpus,
  gpuClaimConflict,
  listGpuClaims,
  releaseGpus,
  resetGpuClaims,
} from "./gpuClaims";
import type { ServerDefinition } from "../shared/types";

function fakeDef(overrides: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    id: "a",
    name: "alpha",
    engine: "llamacpp",
    backend: "cuda",
    gpuDevices: [0],
    gpuMode: "single",
    modelId: "m",
    modelPath: "/m.gguf",
    mmprojPath: null,
    contextLength: 4096,
    nGpuLayers: -1,
    kvCacheDtype: "f16",
    engineConfig: {},
    hostPort: 8082,
    apiKey: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("gpuClaimConflict", () => {
  it("allows different GPUs on the same backend", () => {
    const err = gpuClaimConflict(fakeDef({ id: "b", gpuDevices: [1] }), [
      { serverId: "a", name: "alpha", backend: "cuda", gpuDevices: [0], gpuMode: "single" },
    ]);
    assert.equal(err, null);
  });

  it("rejects the same CUDA index used by another server", () => {
    const err = gpuClaimConflict(fakeDef({ id: "b", name: "beta", gpuDevices: [0] }), [
      { serverId: "a", name: "alpha", backend: "cuda", gpuDevices: [0], gpuMode: "single" },
    ]);
    assert.match(err ?? "", /GPU 0 \(cuda\) claimed by server "alpha"/);
  });

  it("allows CUDA 0 and ROCm 0 — different backends", () => {
    const err = gpuClaimConflict(fakeDef({ id: "b", backend: "rocm", gpuDevices: [0] }), [
      { serverId: "a", name: "alpha", backend: "cuda", gpuDevices: [0], gpuMode: "single" },
    ]);
    assert.equal(err, null);
  });

  it("combined mode claims every selected device", () => {
    const err = gpuClaimConflict(
      fakeDef({ id: "b", gpuDevices: [1], gpuMode: "single" }),
      [{ serverId: "a", name: "big", backend: "cuda", gpuDevices: [0, 1], gpuMode: "combined" }],
    );
    assert.match(err ?? "", /GPU 1/);
  });

  it("skips CPU and Metal", () => {
    assert.equal(gpuClaimConflict(fakeDef({ backend: "cpu", gpuDevices: [] }), []), null);
    assert.equal(gpuClaimConflict(fakeDef({ backend: "metal", gpuDevices: [] }), []), null);
  });
});

describe("claimGpus / releaseGpus", () => {
  afterEach(() => resetGpuClaims());

  it("leases exclusive GPUs and frees them on release", () => {
    claimGpus(fakeDef({ id: "a", gpuDevices: [0] }));
    assert.deepEqual(claimedKeys(), ["cuda:0"]);
    assert.throws(
      () => claimGpus(fakeDef({ id: "b", name: "beta", gpuDevices: [0] })),
      /claimed by server "alpha"/,
    );
    claimGpus(fakeDef({ id: "c", gpuDevices: [1] }));
    releaseGpus("a");
    claimGpus(fakeDef({ id: "b", name: "beta", gpuDevices: [0] }));
    assert.equal(listGpuClaims().length, 2);
  });

  it("force records overlapping claims without throwing", () => {
    claimGpus(fakeDef({ id: "a", gpuDevices: [0] }));
    claimGpus(fakeDef({ id: "b", name: "beta", gpuDevices: [0] }), { force: true });
    assert.equal(listGpuClaims().length, 2);
  });
});
