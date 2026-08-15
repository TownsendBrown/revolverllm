import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerDefinition } from "../shared/types";
import { gpuPassthroughSpec, gpuRunArgs } from "./containerUtils";

function fakeDef(overrides: Partial<ServerDefinition>): ServerDefinition {
  return {
    id: "srv",
    name: "test",
    engine: "llamacpp",
    backend: "cuda",
    gpuDevices: [0],
    gpuMode: "single",
    modelId: "org/model",
    modelPath: "/models/m.gguf",
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

describe("gpuRunArgs", () => {
  it("leaves CPU and Metal without device flags", () => {
    assert.deepEqual(gpuRunArgs(fakeDef({ backend: "cpu", gpuDevices: [] })), []);
    assert.deepEqual(gpuRunArgs(fakeDef({ backend: "metal", gpuDevices: [] })), []);
  });

  it("pins CUDA with quoted --gpus device list", () => {
    const args = gpuRunArgs(fakeDef({ backend: "cuda", gpuDevices: [0, 1] }));
    assert.equal(args[0], "--gpus");
    assert.equal(args[1], `"device=0,1"`);
    assert.equal(args[3], "CUDA_VISIBLE_DEVICES=0,1");
  });

  it("passes DRM device nodes and cgroup rules for Vulkan", () => {
    const args = gpuRunArgs(fakeDef({ backend: "vulkan", gpuDevices: [0] }));
    assert.ok(args.includes("/dev/dri:/dev/dri"));
    assert.ok(args.includes("--device-cgroup-rule"));
    assert.ok(args.includes("c 226:* rmw"));
    assert.ok(args.includes("seccomp=unconfined"));
    assert.ok(args.some((a) => a.startsWith("GGML_VK_VISIBLE_DEVICES=")));
  });

  it("uses host HIP index for ROCm", () => {
    const args = gpuRunArgs(fakeDef({ backend: "rocm", gpuDevices: [0] }));
    assert.ok(args.includes("HIP_VISIBLE_DEVICES=0"));
    assert.ok(args.includes("ROCR_VISIBLE_DEVICES=0"));
  });

  it("labels Vulkan passthrough so stale containers recreate", () => {
    assert.equal(gpuPassthroughSpec(fakeDef({ backend: "vulkan" })), "vulkan-dri-device-v1");
    assert.equal(gpuPassthroughSpec(fakeDef({ backend: "cpu", gpuDevices: [] })), "none");
  });
});
