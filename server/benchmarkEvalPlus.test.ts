import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checksFromEvalPlus } from "./benchmarkEvalPlus";
import type { HarnessSummary } from "./benchmarkDockerHarness";

function summary(overrides: Partial<HarnessSummary> = {}): HarnessSummary {
  return {
    schema: 1,
    suite: "evalplus",
    ok: true,
    scores: { basePassAt1: 0.8, plusPassAt1: 0.6 },
    counts: { tasks: 164 },
    generation: { samples: 164, empty: 0, truncated: 0, nonemptyRate: 1 },
    ...overrides,
  };
}

describe("checksFromEvalPlus", () => {
  it("scores base and plus pass@1", () => {
    const checks = checksFromEvalPlus(summary(), 0);
    assert.equal(checks.find((c) => c.id === "evalplus-completed")?.passed, true);
    assert.equal(checks.find((c) => c.id === "evalplus-base-pass-at-1")?.passed, true);
    assert.equal(checks.find((c) => c.id === "evalplus-plus-pass-at-1")?.passed, true);
    assert.match(checks.find((c) => c.id === "evalplus-plus-pass-at-1")?.label ?? "", /60\.0%/);
    assert.equal(checks.find((c) => c.id === "evalplus-coverage")?.label, "Evaluated 164 tasks");
  });

  it("fails every check when the harness reported nothing", () => {
    const checks = checksFromEvalPlus(null, 1);
    assert.equal(checks.find((c) => c.id === "evalplus-completed")?.passed, false);
    assert.equal(checks.find((c) => c.id === "evalplus-base-pass-at-1")?.passed, false);
    assert.match(
      checks.find((c) => c.id === "evalplus-completed")?.detail ?? "",
      /never reported back/,
    );
  });

  it("flags empty generations instead of reporting a plain low score", () => {
    const checks = checksFromEvalPlus(
      summary({
        scores: { basePassAt1: 0.079, plusPassAt1: 0.079 },
        generation: { samples: 164, empty: 134, truncated: 20, nonemptyRate: 30 / 164 },
      }),
      0,
    );
    const health = checks.find((c) => c.id === "evalplus-generation-health");
    assert.equal(health?.passed, false);
    assert.equal(health?.kind, "health");
    assert.match(health?.label ?? "", /30\/164/);
    assert.equal(checks.find((c) => c.id === "evalplus-truncation")?.passed, false);
  });

  it("keeps partial pass@1 when the run timed out", () => {
    const checks = checksFromEvalPlus(
      summary({
        ok: false,
        incomplete: true,
        scores: { basePassAt1: 0.12, plusPassAt1: 0.1 },
        counts: { tasks: 131 },
        errors: ["interrupted (SIGTERM) — scoring samples generated so far"],
      }),
      124,
    );
    assert.equal(checks.find((c) => c.id === "evalplus-completed")?.passed, false);
    assert.match(checks.find((c) => c.id === "evalplus-completed")?.label ?? "", /incomplete/);
    assert.equal(checks.find((c) => c.id === "evalplus-base-pass-at-1")?.passed, true);
    assert.match(checks.find((c) => c.id === "evalplus-coverage")?.label ?? "", /partial/);
  });
});
