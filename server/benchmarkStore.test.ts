import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertArtifactRelPath, readArtifact } from "./benchmarkStore";

describe("benchmarkStore artifact paths", () => {
  it("rejects path traversal in relPath", () => {
    assert.throws(() => assertArtifactRelPath("../etc/passwd"), /Invalid artifact path/);
    assert.throws(() => assertArtifactRelPath("/etc/passwd"), /Invalid artifact path/);
    assert.throws(() => assertArtifactRelPath("foo/../../secret"), /Invalid artifact path/);
  });

  it("readArtifact returns null for traversal without reading", () => {
    assert.equal(readArtifact("run-1", "../outside.txt"), null);
  });
});
