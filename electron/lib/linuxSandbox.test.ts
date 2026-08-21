import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chromeSandboxNeedsNoSandbox, linuxOzonePlatformHint } from "./linuxSandbox";

describe("chromeSandboxNeedsNoSandbox", () => {
  it("accepts root-owned setuid helper", () => {
    assert.equal(chromeSandboxNeedsNoSandbox(0o4755, 0), false);
  });

  it("rejects helper without setuid or root owner", () => {
    assert.equal(chromeSandboxNeedsNoSandbox(0o755, 0), true);
    assert.equal(chromeSandboxNeedsNoSandbox(0o4755, 1000), true);
  });
});

describe("linuxOzonePlatformHint", () => {
  it("defaults to x11 so Wayland NVIDIA does not paint a blank window", () => {
    assert.equal(linuxOzonePlatformHint({}), "x11");
  });

  it("leaves Electron's env override alone", () => {
    assert.equal(linuxOzonePlatformHint({ ELECTRON_OZONE_PLATFORM_HINT: "wayland" }), null);
    assert.equal(linuxOzonePlatformHint({ ELECTRON_OZONE_PLATFORM_HINT: "auto" }), null);
  });
});
