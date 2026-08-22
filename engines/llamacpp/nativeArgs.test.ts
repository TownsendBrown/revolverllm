import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLlamaServerArgs, falsyFlag, truthyFlag } from "./nativeArgs";

describe("buildLlamaServerArgs", () => {
  it("builds host/port/model plus optional flags", () => {
    const args = buildLlamaServerArgs(
      {
        MODEL_PATH: "C:\\models\\tiny.gguf",
        CTX_SIZE: "2048",
        N_GPU_LAYERS: "12",
        FLASH_ATTN: "on",
        JINJA: "on",
        KV_UNIFIED: "1",
      },
      8082,
    );
    assert.deepEqual(args.slice(0, 6), ["--host", "127.0.0.1", "--port", "8082", "--model", "C:\\models\\tiny.gguf"]);
    assert.ok(args.includes("--ctx-size"));
    assert.ok(args.includes("--jinja"));
    assert.ok(args.includes("--kv-unified"));
  });

  it("omits jinja when JINJA=off", () => {
    const args = buildLlamaServerArgs({ MODEL_PATH: "/m.gguf", JINJA: "off" }, 9);
    assert.equal(args.includes("--jinja"), false);
    assert.equal(truthyFlag("yes"), true);
    assert.equal(falsyFlag("no"), true);
  });
});
