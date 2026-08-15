import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chromeSandboxNeedsNoSandbox } from "./linuxSandbox";

describe("chromeSandboxNeedsNoSandbox", () => {
  it("accepts root-owned setuid helper", () => {
    assert.equal(chromeSandboxNeedsNoSandbox(0o4755, 0), false);
  });

  it("rejects helper without setuid or root owner", () => {
    assert.equal(chromeSandboxNeedsNoSandbox(0o755, 0), true);
    assert.equal(chromeSandboxNeedsNoSandbox(0o4755, 1000), true);
  });
});
