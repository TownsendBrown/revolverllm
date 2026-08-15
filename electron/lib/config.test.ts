import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "path";
import { resolveDataDir } from "./config";

describe("resolveDataDir", () => {
  it("prefers REVOLVER_DATA_DIR over packaged userData", () => {
    assert.equal(
      resolveDataDir({
        envDataDir: "/custom/data",
        packaged: true,
        userDataDir: "/home/u/.config/Revolver",
        repoRoot: "/opt/Revolver",
        repoDataWritable: true,
        fallbackDir: "/home/u/.revolver/data",
      }),
      "/custom/data",
    );
  });

  it("uses userData when packaged", () => {
    assert.equal(
      resolveDataDir({
        packaged: true,
        userDataDir: "/home/u/.config/Revolver",
        repoRoot: "/opt/Revolver",
        repoDataWritable: true,
        fallbackDir: "/home/u/.revolver/data",
      }),
      "/home/u/.config/Revolver",
    );
  });

  it("uses repo data/ when writable in unpackaged checkout", () => {
    assert.equal(
      resolveDataDir({
        packaged: false,
        repoRoot: "/home/u/revolver",
        repoDataWritable: true,
        fallbackDir: "/home/u/.revolver/data",
      }),
      join("/home/u/revolver", "data"),
    );
  });

  it("falls back when repo data/ is not writable", () => {
    assert.equal(
      resolveDataDir({
        packaged: false,
        repoRoot: "/home/u/revolver",
        repoDataWritable: false,
        fallbackDir: "/home/u/.revolver/data",
      }),
      "/home/u/.revolver/data",
    );
  });
});
