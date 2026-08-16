import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getApiKey, hasApiKeyConfigured, checkApiAuth } from "./apiAuth";

describe("apiAuth", () => {
  it("uses REVOLVER_API_KEY env when set", () => {
    const prev = process.env.REVOLVER_API_KEY;
    process.env.REVOLVER_API_KEY = "test-key-123";
    try {
      assert.equal(getApiKey(), "test-key-123");
      assert.equal(hasApiKeyConfigured(), true);
    } finally {
      if (prev === undefined) delete process.env.REVOLVER_API_KEY;
      else process.env.REVOLVER_API_KEY = prev;
    }
  });

  it("checkApiAuth rejects missing bearer when key configured", () => {
    const prev = process.env.REVOLVER_API_KEY;
    process.env.REVOLVER_API_KEY = "secret";
    let status = 0;
    let body: unknown;
    const req = { headers: {} } as import("express").Request;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as import("express").Response;
    try {
      assert.equal(checkApiAuth(req, res), false);
      assert.equal(status, 401);
      assert.deepEqual(body, { error: "Unauthorized" });
    } finally {
      if (prev === undefined) delete process.env.REVOLVER_API_KEY;
      else process.env.REVOLVER_API_KEY = prev;
    }
  });
});
