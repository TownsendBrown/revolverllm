import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  cudaVisibleDevices,
  defaultRuntimeMode,
  inComposeBackend,
  isNativeRuntime,
  resolveServerRuntime,
  usesHostModelPaths,
  visibleDeviceEnv,
} from "./runtimeMode";
import type { ServerDefinition } from "./types";
import { buildLlamaLoadEnv } from "../engines/llamacpp/config";

function fakeDef(overrides: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    id: "srv",
    name: "test",
    engine: "llamacpp",
    backend: "cuda",
    gpuDevices: [1, 3],
    gpuMode: "combined",
    modelId: "org/model",
    modelPath: "/home/ape/models/m.gguf",
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

describe("resolveServerRuntime", () => {
  it("maps metal to metal regardless of runtime field", () => {
    assert.equal(resolveServerRuntime(fakeDef({ backend: "metal", runtime: "docker" })), "metal");
    assert.equal(isNativeRuntime(fakeDef({ backend: "metal" })), false);
    assert.equal(usesHostModelPaths(fakeDef({ backend: "metal" })), true);
  });

  it("honors explicit native / docker", () => {
    assert.equal(resolveServerRuntime(fakeDef({ runtime: "native" })), "native");
    assert.equal(resolveServerRuntime(fakeDef({ runtime: "docker" })), "docker");
  });
});

describe("visible devices", () => {
  it("uses relative CUDA indices inside Docker", () => {
    const def = fakeDef({ runtime: "docker", gpuDevices: [1, 3] });
    assert.equal(cudaVisibleDevices(def), "0,1");
    assert.equal(visibleDeviceEnv(def).CUDA_VISIBLE_DEVICES, "0,1");
  });

  it("uses host CUDA indices for native processes", () => {
    const def = fakeDef({ runtime: "native", gpuDevices: [1, 3] });
    assert.equal(cudaVisibleDevices(def), "1,3");
    assert.equal(visibleDeviceEnv(def).CUDA_VISIBLE_DEVICES, "1,3");
  });

  it("passes host HIP indices for ROCm in both modes", () => {
    const docker = fakeDef({ backend: "rocm", runtime: "docker", gpuDevices: [2] });
    const native = fakeDef({ backend: "rocm", runtime: "native", gpuDevices: [2] });
    assert.equal(visibleDeviceEnv(docker).HIP_VISIBLE_DEVICES, "2");
    assert.equal(visibleDeviceEnv(native).HIP_VISIBLE_DEVICES, "2");
  });
});

describe("buildLlamaLoadEnv native vs docker", () => {
  it("writes host paths, host port, and host CUDA indices for native", () => {
    const plan = buildLlamaLoadEnv(fakeDef({ runtime: "native", hostPort: 8099 }));
    assert.equal(plan.env.MODEL_PATH, "/home/ape/models/m.gguf");
    assert.equal(plan.env.LLAMA_PORT, 8099);
    assert.equal(plan.env.CUDA_VISIBLE_DEVICES, "1,3");
  });

  it("keeps container-relative CUDA indices for docker", () => {
    const plan = buildLlamaLoadEnv(fakeDef({ runtime: "docker" }));
    assert.equal(plan.env.CUDA_VISIBLE_DEVICES, "0,1");
    assert.equal(plan.env.LLAMA_PORT, 8080);
  });
});

describe("env defaults", () => {
  afterEach(() => {
    delete process.env.REVOLVER_RUNTIME;
    delete process.env.REVOLVER_COMPOSE;
  });

  it("defaults to docker unless REVOLVER_RUNTIME=native", () => {
    delete process.env.REVOLVER_RUNTIME;
    assert.equal(defaultRuntimeMode(), "docker");
    assert.equal(resolveServerRuntime(fakeDef({})), "docker");
    process.env.REVOLVER_RUNTIME = "native";
    assert.equal(defaultRuntimeMode(), "native");
    assert.equal(resolveServerRuntime(fakeDef({})), "docker");
    assert.equal(resolveServerRuntime(fakeDef({ runtime: "native" })), "native");
  });

  it("detects compose backend via REVOLVER_COMPOSE", () => {
    delete process.env.REVOLVER_COMPOSE;
    assert.equal(inComposeBackend(), false);
    process.env.REVOLVER_COMPOSE = "1";
    assert.equal(inComposeBackend(), true);
  });
});
