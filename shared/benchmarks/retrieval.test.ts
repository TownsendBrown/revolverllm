import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  answerContainsPassphrase,
  buildHaystack,
  insertNeedle,
  makePassphrase,
  needleSentence,
} from "./retrieval";

describe("retrieval helpers", () => {
  it("passphrases are deterministic and vary by depth/trial", () => {
    assert.equal(makePassphrase(50, 1), makePassphrase(50, 1));
    assert.notEqual(makePassphrase(50, 1), makePassphrase(50, 2));
    assert.notEqual(makePassphrase(25, 1), makePassphrase(50, 1));
    assert.match(makePassphrase(0, 0), /^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("haystack is deterministic and roughly target-sized", () => {
    const a = buildHaystack(10_000);
    const b = buildHaystack(10_000);
    assert.equal(a, b);
    assert.ok(a.length >= 10_000 && a.length < 10_400);
  });

  it("inserts the needle intact at each depth", () => {
    const haystack = buildHaystack(5_000);
    const needle = needleSentence("amber-fjord-123");
    for (const depth of [0, 25, 50, 75, 100]) {
      const doc = insertNeedle(haystack, needle, depth);
      assert.ok(doc.includes(needle), `needle split at depth ${depth}`);
    }
    assert.ok(insertNeedle(haystack, needle, 0).startsWith(needle));
    assert.ok(insertNeedle(haystack, needle, 100).endsWith(needle));
    const mid = insertNeedle(haystack, needle, 50).indexOf(needle);
    assert.ok(mid > haystack.length * 0.4 && mid < haystack.length * 0.6);
  });

  it("matches answers tolerantly but not wrong passphrases", () => {
    assert.ok(answerContainsPassphrase("The passphrase is amber-fjord-123.", "amber-fjord-123"));
    assert.ok(answerContainsPassphrase("AMBER - FJORD - 123", "amber-fjord-123"));
    assert.ok(answerContainsPassphrase("amber_fjord_123", "amber-fjord-123"));
    assert.ok(!answerContainsPassphrase("amber-fjord-124", "amber-fjord-123"));
    assert.ok(!answerContainsPassphrase("I could not find it.", "amber-fjord-123"));
  });
});
