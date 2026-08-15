import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import {
  listInstalledPacks,
  mergeLibPath,
  readInstalledPack,
  resolveInstalledBackendPack,
} from "./nativeBackends";
import type { BackendCatalog } from "../shared/nativeBackends";

const catalog: BackendCatalog = {
  schemaVersion: 1,
  llamaCppRepo: "https://example.invalid/llama.cpp.git",
  llamaCppTag: "b0",
  packs: [
    {
      id: "linux-cuda-sm70",
      label: "CUDA Volta (sm_70)",
      os: "linux",
      cpuArch: "x86_64",
      backend: "cuda",
      cudaArchitectures: "70-real",
      matchComputeCaps: [70],
    },
    {
      id: "linux-cuda-pascal",
      label: "CUDA Pascal",
      os: "linux",
      cpuArch: "x86_64",
      backend: "cuda",
      cudaArchitectures: "60-real;61-real",
      matchComputeCaps: [60, 61],
    },
  ],
};

function fakePack(root: string, id: string): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  const bin = join(dir, "bin", "llama-server");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      os: "linux",
      backend: "cuda",
      matchComputeCaps: id.includes("sm70") ? [70] : [60, 61],
      binary: "bin/llama-server",
      libDir: "lib",
    }) + "\n",
  );
  return dir;
}

describe("installed backend packs", () => {
  it("reads a staged sm70 pack", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-pack-"));
    const dir = fakePack(root, "linux-cuda-sm70");
    const pack = readInstalledPack(dir, catalog);
    assert.ok(pack);
    assert.equal(pack.spec.id, "linux-cuda-sm70");
    assert.ok(pack.bin.endsWith("bin/llama-server"));
  });

  it("picks sm70 when the host reports compute cap 70", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-packs-"));
    fakePack(root, "linux-cuda-sm70");
    fakePack(root, "linux-cuda-pascal");
    const hit = resolveInstalledBackendPack({
      catalog,
      roots: [root],
      computeCaps: [70],
      platform: "linux",
    });
    assert.equal(hit?.packId, "linux-cuda-sm70");
  });

  it("skips CUDA packs on darwin", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-packs-"));
    fakePack(root, "linux-cuda-sm70");
    const hit = resolveInstalledBackendPack({
      catalog,
      roots: [root],
      computeCaps: [70],
      platform: "darwin",
    });
    assert.equal(hit, null);
  });

  it("lists packs under a search root", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-packs-"));
    fakePack(root, "linux-cuda-sm70");
    assert.equal(listInstalledPacks([root], catalog).length, 1);
  });

  it("prepends pack lib dir onto LD_LIBRARY_PATH", () => {
    const env = mergeLibPath({ LD_LIBRARY_PATH: "/opt/foo" }, "/pack/lib");
    assert.equal(env.LD_LIBRARY_PATH, "/pack/lib:/opt/foo");
  });
});
