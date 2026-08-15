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

const sm70 = catalog.packs.find((p) => p.id === "linux-cuda-sm70") as BackendPackSpec;
const pascal = catalog.packs.find((p) => p.id === "linux-cuda-pascal") as BackendPackSpec;

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
  it("catalog lists sm70 and pascal as linux cuda", () => {
    assert.ok(sm70);
    assert.ok(pascal);
    assert.deepEqual(sm70.matchComputeCaps, [70]);
    assert.deepEqual(pascal.matchComputeCaps, [60, 61]);
  });

  it("picks sm70 for V100", () => {
    const hit = pickBackendPack(catalog.packs, { os: "linux", computeCaps: [70] });
    assert.equal(hit?.id, "linux-cuda-sm70");
  });

  it("picks pascal for P100 / GTX 1080", () => {
    assert.equal(pickBackendPack(catalog.packs, { os: "linux", computeCaps: [60] })?.id, "linux-cuda-pascal");
    assert.equal(pickBackendPack(catalog.packs, { os: "linux", computeCaps: [61] })?.id, "linux-cuda-pascal");
  });

  it("does not pick a CUDA pack on macOS", () => {
    assert.equal(pickBackendPack(catalog.packs, { os: "darwin", computeCaps: [70] }), null);
  });

  it("returns null when no pack covers the SM", () => {
    assert.equal(pickBackendPack(catalog.packs, { os: "linux", computeCaps: [89] }), null);
  });

  it("honors forcePackId", () => {
    const hit = pickBackendPack(catalog.packs, {
      os: "linux",
      computeCaps: [70],
      forcePackId: "linux-cuda-pascal",
    });
    assert.equal(hit?.id, "linux-cuda-pascal");
  });

  it("match helper", () => {
    assert.equal(packMatchesAnyCap(sm70, [70, 89]), true);
    assert.equal(packMatchesAnyCap(sm70, [60]), false);
  });
});
