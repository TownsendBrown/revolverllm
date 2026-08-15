import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toIpcError } from "./ipcErrors";

describe("toIpcError", () => {
  it("rewrites EACCES with the path", () => {
    const e = Object.assign(new Error("EACCES: permission denied, mkdir '/x'"), {
      code: "EACCES",
      path: "/x/benchmarks/runs",
    });
    const out = toIpcError(e);
    assert.match(out.message, /Permission denied/);
    assert.match(out.message, /benchmarks\/runs/);
  });

  it("passes through other Error messages", () => {
    assert.equal(toIpcError(new Error("Conversation not found")).message, "Conversation not found");
  });

  it("stringifies non-errors", () => {
    assert.equal(toIpcError("boom").message, "boom");
  });
});
