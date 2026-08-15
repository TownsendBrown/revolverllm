import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  containerLogTail,
  extractHarnessSummary,
  renderEnvFile,
  SUMMARY_BEGIN,
  SUMMARY_END,
} from "./benchmarkDockerHarness";

const block = (json: string) => `${SUMMARY_BEGIN}\n${json}\n${SUMMARY_END}`;

describe("extractHarnessSummary", () => {
  it("reads the summary block out of a noisy log", () => {
    const log = [
      "Codegen: HumanEval/0 @ local",
      "humaneval 100% 164/164",
      block('{"schema":1,"suite":"evalplus","ok":true,"scores":{"basePassAt1":0.42}}'),
      "",
    ].join("\n");
    const summary = extractHarnessSummary(log);
    assert.equal(summary?.suite, "evalplus");
    assert.equal(summary?.scores.basePassAt1, 0.42);
  });

  it("returns null without a block", () => {
    assert.equal(extractHarnessSummary("no summary here"), null);
  });

  it("skips malformed blocks and keeps the last valid one", () => {
    const log = [block("{not json"), block('{"schema":1,"suite":"lcb","ok":true,"scores":{}}')].join(
      "\n",
    );
    assert.equal(extractHarnessSummary(log)?.suite, "lcb");
  });
});

describe("renderEnvFile", () => {
  it("emits bare KEY=VALUE lines", () => {
    assert.equal(
      renderEnvFile({ OPENAI_BASE_URL: "http://host.docker.internal:8147/v1", LCB_N: "1" }),
      "OPENAI_BASE_URL=http://host.docker.internal:8147/v1\nLCB_N=1\n",
    );
  });

  it("flattens newlines that would break the file format", () => {
    assert.equal(renderEnvFile({ KEY: "a\nb" }), "KEY=a b\n");
  });
});

describe("containerLogTail", () => {
  it("drops the summary block and keeps the last lines", () => {
    const log = ["one", "two", block('{"schema":1}'), "three"].join("\n");
    const tail = containerLogTail(log, "", 3);
    assert.ok(!tail.includes(SUMMARY_BEGIN));
    assert.equal(tail.split("\n").length, 3);
    assert.ok(tail.endsWith("three"));
  });
});
