import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checksFromLiveCodeBench } from "./benchmarkLiveCodeBench";
import type { HarnessSummary } from "./benchmarkDockerHarness";

function summary(overrides: Partial<HarnessSummary> = {}): HarnessSummary {
  return {
    schema: 1,
    suite: "livecodebench",
    ok: true,
    scores: { passAt1: 0.5, passAt5: 0.7 },
    counts: { problems: 15 },
    generation: { samples: 15, empty: 0, truncated: 0, nonemptyRate: 1 },
    ...overrides,
  };
}

describe("checksFromLiveCodeBench", () => {
  it("scores pass@1 and pass@5", () => {
    const checks = checksFromLiveCodeBench(summary(), 0);
    assert.equal(checks.find((c) => c.id === "lcb-completed")?.passed, true);
    assert.match(checks.find((c) => c.id === "lcb-pass-at-1")?.label ?? "", /50\.0%/);
    assert.match(checks.find((c) => c.id === "lcb-pass-at-5")?.label ?? "", /70\.0%/);
    assert.equal(checks.find((c) => c.id === "lcb-coverage")?.label, "Evaluated 15 problems");
  });

  it("omits pass@5 when the harness did not report it", () => {
    const checks = checksFromLiveCodeBench(summary({ scores: { passAt1: 0.2, passAt5: null } }), 0);
    assert.equal(
      checks.find((c) => c.id === "lcb-pass-at-5"),
      undefined,
    );
  });

  it("fails without a summary", () => {
    const checks = checksFromLiveCodeBench(null, 1);
    assert.equal(checks.find((c) => c.id === "lcb-completed")?.passed, false);
    assert.equal(checks.find((c) => c.id === "lcb-pass-at-1")?.passed, false);
  });

  it("separates a zero score from a run where nothing was generated", () => {
    const checks = checksFromLiveCodeBench(
      summary({
        scores: { passAt1: 0, passAt5: null },
        generation: { samples: 15, empty: 15, truncated: 0, nonemptyRate: 0 },
      }),
      0,
    );
    const health = checks.find((c) => c.id === "lcb-generation-health");
    assert.equal(health?.passed, false);
    assert.match(health?.detail ?? "", /token budget/);
    assert.equal(checks.find((c) => c.id === "lcb-pass-at-1")?.kind, "score");
  });
});
