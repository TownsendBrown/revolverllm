import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  amdPciMeta,
  applyVulkanIndices,
  assignUniqueIndices,
  backendGpuHint,
  deviceUsableForBackend,
  devicesForBackend,
  parseDrmUevent,
  parseVulkanSummary,
  recommendedWizardBackend,
  rocmLikelySupported,
  runtimeIndicesFromSelection,
  validateBackendDevices,
  vulkanDriverEnv,
} from "./gpuDevices";
import type { GpuDevice, GpuInfo } from "./types";
import { scanAmdGpusFromSysfs } from "../electron/lib/gpu";

function gpu(partial: Partial<GpuDevice> & Pick<GpuDevice, "index" | "vendor" | "name">): GpuDevice {
  return {
    recommendedBackend: partial.vendor === "nvidia" ? "cuda" : partial.vendor === "apple" ? "metal" : "vulkan",
    totalBytes: 8 * 1024 ** 3,
    usedBytes: 1024 ** 3,
    freeBytes: 7 * 1024 ** 3,
    totalGb: 8,
    freeGb: 7,
    nvidiaIndex: null,
    amdIndex: null,
    vulkanIndex: null,
    arch: null,
    ...partial,
  };
}

const VULKAN_SUMMARY = `
Devices:
========
GPU0:
	vendorID           = 0x1002
	deviceID           = 0x731f
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = AMD Radeon RX 5700 XT (RADV NAVI10)
	driverName         = radv
GPU1:
	vendorID           = 0x10de
	deviceID           = 0x1db6
	deviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
	deviceName         = Tesla V100-PCIE-32GB
	driverName         = NVIDIA
GPU2:
	vendorID           = 0x10005
	deviceID           = 0x0000
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 21.1.8, 256 bits)
	driverName         = llvmpipe
`;

describe("amdPciMeta", () => {
  it("maps Navi 10 731f to RX 5700 XT / gfx1010", () => {
    const meta = amdPciMeta("731F");
    assert.equal(meta.name, "Radeon RX 5700 XT");
    assert.equal(meta.arch, "gfx1010");
    assert.equal(rocmLikelySupported(meta.arch), false);
  });

  it("treats RDNA3 as ROCm-capable", () => {
    assert.equal(rocmLikelySupported(amdPciMeta("744c").arch), true);
  });
});

describe("parseDrmUevent", () => {
  it("reads PCI ids from amdgpu uevent", () => {
    const parsed = parseDrmUevent(
      "DRIVER=amdgpu\nPCI_ID=1002:731F\nPCI_SLOT_NAME=0000:04:00.0\n",
    );
    assert.equal(parsed.driver, "amdgpu");
    assert.equal(parsed.vendorId, "1002");
    assert.equal(parsed.deviceId, "731f");
    assert.equal(parsed.slot, "0000:04:00.0");
  });
});

describe("parseVulkanSummary", () => {
  it("drops llvmpipe and keeps discrete GPUs", () => {
    const devices = parseVulkanSummary(VULKAN_SUMMARY);
    assert.equal(devices.length, 2);
    assert.equal(devices[0].vulkanIndex, 0);
    assert.equal(devices[0].vendorId, "1002");
    assert.equal(devices[0].name, "AMD Radeon RX 5700 XT (RADV NAVI10)");
    assert.equal(devices[1].vulkanIndex, 1);
    assert.equal(devices[1].vendorId, "10de");
  });
});

describe("applyVulkanIndices", () => {
  it("maps AMD HIP 0 to Vulkan 0 and NVIDIA smi 0 to Vulkan 1", () => {
    const merged = applyVulkanIndices(
      assignUniqueIndices([
        gpu({
          index: 0,
          vendor: "nvidia",
          name: "Tesla V100",
          nvidiaIndex: 0,
        }),
        gpu({
          index: 1,
          vendor: "amd",
          name: "Radeon RX 5700 XT",
          amdIndex: 0,
          arch: "gfx1010",
        }),
      ]),
      parseVulkanSummary(VULKAN_SUMMARY),
    );
    assert.equal(merged[0].vulkanIndex, 1);
    assert.equal(merged[0].name, "Tesla V100-PCIE-32GB");
    assert.equal(merged[1].vulkanIndex, 0);
    assert.match(merged[1].name, /5700 XT/);
  });
});

describe("backend selection", () => {
  const mixed: GpuInfo = {
    available: true,
    deviceCount: 2,
    totalVramBytes: 40 * 1024 ** 3,
    totalFreeVramBytes: 36 * 1024 ** 3,
    devices: [
      gpu({ index: 0, vendor: "nvidia", name: "Tesla V100", nvidiaIndex: 0, vulkanIndex: 1 }),
      gpu({
        index: 1,
        vendor: "amd",
        name: "Radeon RX 5700 XT",
        amdIndex: 0,
        vulkanIndex: 0,
        arch: "gfx1010",
      }),
    ],
  };

  it("defaults mixed NVIDIA+AMD to CUDA", () => {
    assert.equal(recommendedWizardBackend(false, true, mixed), "cuda");
  });

  it("defaults AMD-only to Vulkan", () => {
    const amdOnly = { ...mixed, devices: [mixed.devices[1]], deviceCount: 1 };
    assert.equal(recommendedWizardBackend(false, false, amdOnly), "vulkan");
  });

  it("maps UI unique AMD index to Vulkan device 0", () => {
    assert.deepEqual(runtimeIndicesFromSelection(mixed.devices, [1], "vulkan"), [0]);
    assert.deepEqual(runtimeIndicesFromSelection(mixed.devices, [0], "cuda"), [0]);
  });

  it("does not map AMD unique index onto CUDA runtime devices", () => {
    assert.deepEqual(runtimeIndicesFromSelection(mixed.devices, [1], "cuda"), []);
  });

  it("filters CUDA to NVIDIA and excludes RDNA1 from ROCm", () => {
    assert.deepEqual(
      devicesForBackend(mixed.devices, "cuda").map((d) => d.vendor),
      ["nvidia"],
    );
    assert.deepEqual(devicesForBackend(mixed.devices, "rocm"), []);
    const rdna2 = gpu({
      index: 2,
      vendor: "amd",
      name: "Radeon RX 6950 XT",
      amdIndex: 1,
      arch: "gfx1030",
    });
    assert.deepEqual(
      devicesForBackend([...mixed.devices, rdna2], "rocm").map((d) => d.name),
      ["Radeon RX 6950 XT"],
    );
  });

  it("blocks CUDA on RX 5700 XT and ROCm on Navi 10", () => {
    assert.equal(deviceUsableForBackend(mixed.devices[1], "cuda"), false);
    assert.equal(deviceUsableForBackend(mixed.devices[1], "rocm"), false);
    assert.equal(deviceUsableForBackend(mixed.devices[1], "vulkan"), true);
    assert.match(validateBackendDevices("cuda", [mixed.devices[1]]) ?? "", /CUDA requires an NVIDIA GPU/);
    assert.match(validateBackendDevices("cuda", mixed.devices, [1]) ?? "", /not NVIDIA/);
    assert.match(validateBackendDevices("rocm", mixed.devices, [1]) ?? "", /Vulkan/);
    assert.equal(validateBackendDevices("vulkan", mixed.devices, [1]), null);
    assert.equal(validateBackendDevices("cuda", mixed.devices, [0]), null);
    assert.match(validateBackendDevices("rocm", mixed.devices, [0]) ?? "", /Vulkan|5700/);
  });

  it("warns that Navi 10 cannot use ROCm", () => {
    const hint = backendGpuHint("rocm", mixed.devices);
    assert.match(hint ?? "", /Vulkan/);
    assert.match(hint ?? "", /5700 XT/);
  });

  it("pins RADV and remaps visible devices to 0 after ICD pin", () => {
    const env = vulkanDriverEnv(
      [
        gpu({
          index: 0,
          vendor: "nvidia",
          name: "Tesla V100",
          nvidiaIndex: 0,
          vulkanIndex: 1,
        }),
        gpu({
          index: 1,
          vendor: "amd",
          name: "RX 5700 XT",
          amdIndex: 0,
          vulkanIndex: 0,
          arch: "gfx1010",
        }),
      ],
      [0],
    );
    assert.equal(env.VK_LOADER_DRIVERS_DISABLE, "lvp");
    assert.match(env.VK_ICD_FILENAMES ?? "", /radeon_icd/);
    assert.equal(env.GGML_VK_VISIBLE_DEVICES, "0");
  });

  it("remaps host Vulkan index 1 to 0 when RADV is the only ICD", () => {
    const env = vulkanDriverEnv(
      [
        gpu({
          index: 0,
          vendor: "nvidia",
          name: "Tesla V100",
          nvidiaIndex: 0,
          vulkanIndex: 0,
        }),
        gpu({
          index: 1,
          vendor: "amd",
          name: "RX 5700 XT",
          amdIndex: 0,
          vulkanIndex: 1,
          arch: "gfx1010",
        }),
      ],
      [1],
    );
    assert.match(env.VK_ICD_FILENAMES ?? "", /radeon_icd/);
    assert.equal(env.GGML_VK_VISIBLE_DEVICES, "0");
  });
});

describe("scanAmdGpusFromSysfs", () => {
  it("reads Navi 10 VRAM from a fake drm tree", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-drm-"));
    const card = join(root, "class/drm/card2/device");
    mkdirSync(card, { recursive: true });
    writeFileSync(join(card, "vendor"), "0x1002\n");
    writeFileSync(join(card, "device"), "0x731f\n");
    writeFileSync(
      join(card, "uevent"),
      "DRIVER=amdgpu\nPCI_ID=1002:731F\nPCI_SLOT_NAME=0000:04:00.0\n",
    );
    writeFileSync(join(card, "mem_info_vram_total"), "8573157376\n");
    writeFileSync(join(card, "mem_info_vram_used"), "869998592\n");
    writeFileSync(join(card, "gpu_busy_percent"), "5\n");

    const nvidiaCard = join(root, "class/drm/card1/device");
    mkdirSync(nvidiaCard, { recursive: true });
    writeFileSync(join(nvidiaCard, "vendor"), "0x10de\n");
    writeFileSync(join(nvidiaCard, "uevent"), "DRIVER=nvidia\nPCI_ID=10DE:1DB6\n");

    const devices = scanAmdGpusFromSysfs(root);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].vendor, "amd");
    assert.equal(devices[0].amdIndex, 0);
    assert.equal(devices[0].arch, "gfx1010");
    assert.equal(devices[0].totalBytes, 8573157376);
    assert.equal(devices[0].recommendedBackend, "vulkan");
    assert.match(devices[0].name, /5700 XT|AMD GPU/);
  });
});
