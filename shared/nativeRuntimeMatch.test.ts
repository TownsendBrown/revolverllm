import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GpuDevice } from "./types";
import {
  cudaSkuMatchesCaps,
  isLinuxRuntimeId,
  linuxCudaSkuForCaps,
  linuxRuntimeBackend,
  nativeSkuBlock,
  recommendedLinuxRuntimeId,
} from "./nativeRuntimeMatch";

function gpu(partial: Partial<GpuDevice> & Pick<GpuDevice, "vendor">): GpuDevice {
  return {
    index: 0,
    name: "gpu",
    recommendedBackend: partial.vendor === "nvidia" ? "cuda" : "vulkan",
    arch: null,
    nvidiaIndex: partial.vendor === "nvidia" ? 0 : null,
    amdIndex: partial.vendor === "amd" ? 0 : null,
    vulkanIndex: 0,
    totalBytes: 1,
    usedBytes: 0,
    freeBytes: 1,
    totalGb: 1,
    freeGb: 1,
    ...partial,
  };
}

describe("linux runtime match", () => {
  it("maps ids to backends", () => {
    assert.equal(linuxRuntimeBackend("linux-cuda"), "cuda");
    assert.equal(linuxRuntimeBackend("linux-vulkan"), "vulkan");
    assert.equal(linuxRuntimeBackend("linux-cpu"), "cpu");
    assert.equal(isLinuxRuntimeId("linux-cpu"), true);
    assert.equal(isLinuxRuntimeId("mlx"), false);
  });

  it("picks the single CUDA SKU for any compute cap", () => {
    assert.equal(linuxCudaSkuForCaps([70]), "linux-cuda");
    assert.equal(linuxCudaSkuForCaps([61]), "linux-cuda");
    assert.equal(linuxCudaSkuForCaps([89]), "linux-cuda");
    assert.equal(linuxCudaSkuForCaps([]), null);
    assert.equal(cudaSkuMatchesCaps("linux-cuda", [89]), true);
    assert.equal(cudaSkuMatchesCaps("linux-vulkan", [89]), false);
  });

  it("recommends CUDA / Vulkan / CPU from vendor", () => {
    const nvidia = {
      available: true,
      deviceCount: 1,
      totalVramBytes: 1,
      totalFreeVramBytes: 1,
      devices: [gpu({ vendor: "nvidia" as const })],
    };
    assert.equal(recommendedLinuxRuntimeId({ computeCaps: [70], gpu: nvidia }), "linux-cuda");
    assert.equal(recommendedLinuxRuntimeId({ computeCaps: [89], gpu: nvidia }), "linux-cuda");
    assert.equal(
      recommendedLinuxRuntimeId({
        computeCaps: [],
        gpu: {
          available: true,
          deviceCount: 1,
          totalVramBytes: 1,
          totalFreeVramBytes: 1,
          devices: [gpu({ vendor: "amd", name: "RX 5700 XT" })],
        },
      }),
      "linux-vulkan",
    );
    assert.equal(recommendedLinuxRuntimeId({ computeCaps: [], gpu: null }), "linux-cpu");
  });

  it("blocks CUDA until the SKU is installed", () => {
    const nvidia = [gpu({ vendor: "nvidia", name: "Tesla V100" })];
    assert.match(
      nativeSkuBlock("cuda", { installed: [], computeCaps: [70], devices: nvidia }) ?? "",
      /CUDA/,
    );
    assert.equal(
      nativeSkuBlock("cuda", { installed: ["linux-cuda"], computeCaps: [70], devices: nvidia }),
      null,
    );
    assert.match(
      nativeSkuBlock("cuda", {
        installed: ["linux-vulkan"],
        computeCaps: [89],
        devices: nvidia,
      }) ?? "",
      /CUDA/,
    );
  });

  it("blocks Vulkan until the SKU is installed", () => {
    const amd = [gpu({ vendor: "amd", name: "RX 5700 XT" })];
    assert.match(
      nativeSkuBlock("vulkan", { installed: [], computeCaps: [], devices: amd }) ?? "",
      /Vulkan/,
    );
    assert.equal(
      nativeSkuBlock("vulkan", { installed: ["linux-vulkan"], computeCaps: [], devices: amd }),
      null,
    );
  });

  it("allows CPU when any llama.cpp SKU is installed", () => {
    assert.match(nativeSkuBlock("cpu", { installed: [], computeCaps: [], devices: [] }) ?? "", /runtime/);
    assert.equal(
      nativeSkuBlock("cpu", { installed: ["linux-cuda"], computeCaps: [70], devices: [] }),
      null,
    );
  });
});
