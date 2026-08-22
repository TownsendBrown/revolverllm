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
      id: "linux-cuda",
      label: "CUDA llama.cpp",
      os: "linux",
      cpuArch: "x86_64",
      backend: "cuda",
      cudaArchitectures: "70-real;75-real;80-real;86-real;89-real;90-real",
      matchComputeCaps: [70, 75, 80, 86, 87, 89, 90],
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
      matchComputeCaps: [70, 75, 80, 86, 87, 89, 90],
      binary: "bin/llama-server",
      libDir: "lib",
    }) + "\n",
  );
  return dir;
}

describe("installed backend packs", () => {
  it("reads a staged cuda pack", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-pack-"));
    const dir = fakePack(root, "linux-cuda");
    const pack = readInstalledPack(dir, catalog);
    assert.ok(pack);
    assert.equal(pack.spec.id, "linux-cuda");
    assert.match(pack.bin.replace(/\\/g, "/"), /bin\/llama-server$/);
  });

  it("picks linux-cuda when the host reports any compute cap", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-packs-"));
    fakePack(root, "linux-cuda");
    const hit = resolveInstalledBackendPack({
      catalog,
      roots: [root],
      computeCaps: [89],
      platform: "linux",
    });
    assert.equal(hit?.packId, "linux-cuda");
  });

  it("skips CUDA packs on darwin", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-packs-"));
    fakePack(root, "linux-cuda");
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
    fakePack(root, "linux-cuda");
    assert.equal(listInstalledPacks([root], catalog).length, 1);
  });

  it("prepends pack lib dir onto LD_LIBRARY_PATH or PATH", () => {
    const env = mergeLibPath({ LD_LIBRARY_PATH: "/opt/foo", PATH: "C:\\Windows" }, "/pack/lib");
    if (process.platform === "win32") {
      assert.match(env.PATH ?? "", /^[/\\]pack[/\\]lib;/);
    } else {
      assert.equal(env.LD_LIBRARY_PATH, "/pack/lib:/opt/foo");
    }
  });

  it("strips AppImage mount dirs from LD_LIBRARY_PATH", { skip: process.platform === "win32" }, () => {
    const prev = process.env.APPDIR;
    process.env.APPDIR = "/tmp/.mount_RevolverXXX";
    try {
      const env = mergeLibPath(
        { LD_LIBRARY_PATH: "/tmp/.mount_RevolverXXX/usr/lib:/usr/lib/x86_64-linux-gnu" },
        "/pack/lib",
      );
      assert.equal(env.LD_LIBRARY_PATH, "/pack/lib:/usr/lib/x86_64-linux-gnu");
    } finally {
      if (prev == null) delete process.env.APPDIR;
      else process.env.APPDIR = prev;
    }
  });
});
