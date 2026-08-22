import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  catalogForUi,
  findLlamaServerBin,
  getRuntimesStatus,
  hasDanglingSymlinks,
  loadRuntimeCatalog,
  moveIntoPlace,
  requiredInstallBytes,
} from "./runtimeInstaller";

describe("runtimeInstaller catalog", () => {
  it("loads pinned catalog from repo", () => {
    const cat = loadRuntimeCatalog();
    assert.equal(cat.schemaVersion, 4);
    assert.equal(cat.llamacpp.tag, "b10453");
    assert.match(cat.llamacpp.sha256, /^[a-f0-9]{64}$/);
    assert.match(cat.llamacpp.url, /TownsendBrown\/revolverllm/);
    assert.equal(cat.mlxRuntime.version, "1.0.0");
    assert.equal(cat.mlxRuntime.pythonVersion, "3.11.15");
    assert.match(cat.mlxRuntime.mlxEngineCommit, /^[a-f0-9]{40}$/);
    assert.ok(cat.linux?.["linux-cuda"]);
    assert.ok(cat.linux?.["linux-vulkan"]);
    assert.ok(cat.linux?.["linux-cpu"]);
    assert.match(cat.linux["linux-cpu"].sha256, /^[a-f0-9]{64}$/);
    assert.ok(cat.win?.["win-cuda"]);
    assert.ok(cat.win?.["win-vulkan"]);
    assert.ok(cat.win?.["win-cpu"]);
    assert.match(cat.win["win-cpu"].sha256, /^[a-f0-9]{64}$/);
    assert.equal(cat.win["win-cpu"].binary, "llama-server.exe");
  });

  it("exposes UI catalog entries", () => {
    const ui = catalogForUi();
    assert.equal(ui.llamacpp.id, "llamacpp");
    assert.equal(ui.mlx.id, "mlx");
    assert.ok(ui.llamacpp.sizeBytes > 0);
    assert.match(ui.mlx.label, /mlx-engine/);
    assert.equal(ui.linux.length, 3);
    assert.ok(ui.linux.some((e) => e.id === "linux-cuda"));
    assert.equal(ui.win.length, 3);
    assert.ok(ui.win.some((e) => e.id === "win-cuda"));
  });

  it("reports install status", () => {
    const st = getRuntimesStatus();
    assert.equal(typeof st.llamacpp.installed, "boolean");
    assert.equal(typeof st.mlx.installed, "boolean");
    assert.ok(st.catalog.llamacpp.label);
    assert.equal(st.linux.length, 3);
    assert.ok(st.catalog.linux.length === 3);
    assert.equal(st.win.length, 3);
    assert.ok(st.catalog.win.length === 3);
  });

  it("budgets space for the archive plus an extracted tree", () => {
    const cat = loadRuntimeCatalog();
    // The 1.0.0 MLX archive extracts to ~1.5 GiB, so the peak is ~2.03 GB.
    const measuredPeak = 1.5 * 1024 ** 3 + cat.mlxRuntime.sizeBytes;
    assert.ok(requiredInstallBytes(cat.mlxRuntime.sizeBytes) > measuredPeak);
  });
});

describe("moveIntoPlace", { skip: process.platform === "win32" }, () => {
  function stagedTree(): { root: string; source: string; install: string } {
    const root = mkdtempSync(join(tmpdir(), "revolver-runtime-"));
    const source = join(root, "staging", "extract");
    mkdirSync(join(source, "bin"), { recursive: true });
    writeFileSync(join(source, "bin", "python3.11"), "#!/bin/sh\n");
    symlinkSync("python3.11", join(source, "bin", "python3"));
    return { root, source, install: join(root, "installed", "1.0.0") };
  }

  it("keeps relative symlinks intact after staging is deleted", () => {
    const { root, source, install } = stagedTree();
    try {
      moveIntoPlace(source, install);
      rmSync(join(root, "staging"), { recursive: true, force: true });

      const link = join(install, "bin", "python3");
      assert.equal(readlinkSync(link), "python3.11");
      assert.ok(existsSync(link), "symlink target must resolve inside the install dir");
      assert.equal(hasDanglingSymlinks(join(install, "bin")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces an existing install tree", () => {
    const { root, source, install } = stagedTree();
    try {
      mkdirSync(install, { recursive: true });
      writeFileSync(join(install, "stale.txt"), "old");

      moveIntoPlace(source, install);

      assert.equal(existsSync(join(install, "stale.txt")), false);
      assert.ok(existsSync(join(install, "bin", "python3.11")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findLlamaServerBin", () => {
  it("finds llama-server.exe next to the unpack root", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-winbin-"));
    try {
      writeFileSync(join(root, "llama-server.exe"), "");
      assert.equal(findLlamaServerBin(root), join(root, "llama-server.exe"));
      assert.equal(findLlamaServerBin(root, "llama-server.exe"), join(root, "llama-server.exe"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hasDanglingSymlinks", () => {
  it("flags a link whose target is gone", { skip: process.platform === "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-dangling-"));
    try {
      symlinkSync(join(root, "missing.dylib"), join(root, "lib.dylib"));
      assert.equal(hasDanglingSymlinks(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a directory with no links", () => {
    const root = mkdtempSync(join(tmpdir(), "revolver-clean-"));
    try {
      writeFileSync(join(root, "llama-server"), "");
      assert.equal(hasDanglingSymlinks(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
