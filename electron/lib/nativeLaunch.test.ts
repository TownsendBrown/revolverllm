import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runtimeFromPackageJson } from "./nativeLaunch";

describe("runtimeFromPackageJson", () => {
  it("reads native / docker hints from pack:native extraMetadata", () => {
    assert.equal(runtimeFromPackageJson({ revolverRuntime: "native" }), "native");
    assert.equal(runtimeFromPackageJson({ revolverRuntime: "docker" }), "docker");
  });

  it("ignores missing or invalid values", () => {
    assert.equal(runtimeFromPackageJson({}), null);
    assert.equal(runtimeFromPackageJson({ revolverRuntime: "metal" }), null);
  });
});
