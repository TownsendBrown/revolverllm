import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bindAbortSignal } from "./abortBridge";

describe("bindAbortSignal", () => {
  it("no-ops when signal missing", () => {
    const unbind = bindAbortSignal(undefined, () => {
      throw new Error("should not fire");
    });
    unbind();
  });

  it("no-ops on contextBridge clone without addEventListener", () => {
    const clone = { aborted: false };
    const unbind = bindAbortSignal(clone, () => {
      throw new Error("should not fire");
    });
    unbind();
  });

  it("binds real AbortSignal", () => {
    const ac = new AbortController();
    let fired = 0;
    const unbind = bindAbortSignal(ac.signal, () => {
      fired += 1;
    });
    ac.abort();
    assert.equal(fired, 1);
    unbind();
  });

  it("unbind stops further notifications", () => {
    const ac = new AbortController();
    let fired = 0;
    const unbind = bindAbortSignal(ac.signal, () => {
      fired += 1;
    });
    unbind();
    ac.abort();
    assert.equal(fired, 0);
  });
});
