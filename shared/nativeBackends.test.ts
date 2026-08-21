import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, it } from "node:test";
import {
  packMatchesAnyCap,
  parseComputeCap,
  parseComputeCapList,
  pickBackendPack,
  type BackendCatalog,
  type BackendPackSpec,
} from "./nativeBackends";

const catalog: BackendCatalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "backends", "catalog.json"), "utf8"),
);

const cuda = catalog.packs.find((p) => p.id === "linux-cuda") as BackendPackSpec;

describe("parseComputeCap", () => {
  it("maps nvidia-smi dotted caps", () => {
    assert.equal(parseComputeCap("7.0"), 70);
    assert.equal(parseComputeCap("6.1"), 61);
    assert.equal(parseComputeCap("12.1"), 121);
  });

  it("accepts already-integer SM ids", () => {
    assert.equal(parseComputeCap("70"), 70);
    assert.deepEqual(parseComputeCapList("7.0,6.1"), [70, 61]);
  });
});

describe("pickBackendPack", () => {
  it("catalog lists one linux cuda fat pack", () => {
    assert.ok(cuda);
    assert.equal(catalog.packs.length, 1);
    assert.ok(cuda.matchComputeCaps.includes(89));
    assert.ok(cuda.matchComputeCaps.includes(70));
  });

  it("picks linux-cuda for any NVIDIA SM on linux", () => {
    assert.equal(pickBackendPack(catalog.packs, { os: "linux", computeCaps: [70] })?.id, "linux-cuda");
    assert.equal(pickBackendPack(catalog.packs, { os: "linux", computeCaps: [89] })?.id, "linux-cuda");
    assert.equal(pickBackendPack(catalog.packs, { os: "linux", computeCaps: [61] })?.id, "linux-cuda");
  });

  it("does not pick a CUDA pack on macOS", () => {
    assert.equal(pickBackendPack(catalog.packs, { os: "darwin", computeCaps: [70] }), null);
  });

  it("honors forcePackId", () => {
    const hit = pickBackendPack(catalog.packs, {
      os: "linux",
      computeCaps: [70],
      forcePackId: "linux-cuda",
    });
    assert.equal(hit?.id, "linux-cuda");
    assert.equal(
      pickBackendPack(catalog.packs, {
        os: "linux",
        computeCaps: [70],
        forcePackId: "missing",
      }),
      null,
    );
  });

  it("match helper", () => {
    assert.equal(packMatchesAnyCap(cuda, [70, 89]), true);
    assert.equal(packMatchesAnyCap(cuda, [60]), false);
  });
});
