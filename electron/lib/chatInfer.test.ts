import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSseChunk, readSseStream } from "./chatInfer";

function sseBytes(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

/** Stream that emits [DONE] then never closes — MLX keep-alive hang. */
function hangingAfterDone(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
    },
  });
}

describe("parseSseChunk", () => {
  it("treats data: [DONE] as terminator, not a skipped no-op", () => {
    assert.equal(parseSseChunk("data: [DONE]"), "DONE");
    assert.equal(parseSseChunk("data: [DONE]\n"), "DONE");
  });

  it("parses content deltas", () => {
    const parsed = parseSseChunk(
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
    );
    assert.ok(parsed && parsed !== "DONE");
    assert.equal(parsed.content, "hi");
  });
});

describe("readSseStream", () => {
  it("returns after [DONE] even if the HTTP body never closes", async () => {
    const deltas: string[] = [];
    const result = await readSseStream(
      hangingAfterDone([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
      (delta) => {
        if (delta.content) deltas.push(delta.content);
      },
      Date.now(),
      false,
    );
    assert.equal(result.content, "Hello world");
    assert.deepEqual(deltas, ["Hello", " world"]);
  });

  it("still completes when the connection closes without [DONE]", async () => {
    const result = await readSseStream(
      sseBytes(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']),
      () => {},
      Date.now(),
      false,
    );
    assert.equal(result.content, "ok");
  });
});
