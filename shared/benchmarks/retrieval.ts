/**
 * Needle-in-a-haystack long-context retrieval — pure, deterministic helpers.
 * All randomness is derived from a fixed seed so runs are replicable.
 */

export const RETRIEVAL_DEPTHS = [0, 25, 50, 75, 100] as const;
export const RETRIEVAL_TRIALS_PER_DEPTH = 3;
export const RETRIEVAL_SEED = 42;

/** mulberry32 — small deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "amber", "basalt", "cobalt", "dune", "ember", "fjord", "granite", "harbor",
  "iris", "juniper", "krypton", "lagoon", "meridian", "nimbus", "onyx", "prairie",
  "quartz", "reef", "sierra", "tundra", "umber", "vertex", "willow", "zephyr",
];

/** Deterministic passphrase for a given (depth, trial) pair. */
export function makePassphrase(depth: number, trial: number): string {
  const rand = seededRandom(RETRIEVAL_SEED * 100_000 + depth * 100 + trial);
  const w1 = WORDS[Math.floor(rand() * WORDS.length)];
  const w2 = WORDS[Math.floor(rand() * WORDS.length)];
  const num = Math.floor(rand() * 900) + 100;
  return `${w1}-${w2}-${num}`;
}

export function needleSentence(passphrase: string): string {
  return `The secret passphrase is ${passphrase}. Remember it exactly.`;
}

const FILLER_SENTENCES = [
  "The quarterly report highlighted steady growth across all regional divisions.",
  "Engineers reviewed the deployment checklist before the scheduled maintenance window.",
  "The library's archive room holds decades of municipal planning documents.",
  "Seasonal rainfall patterns shifted the harvest schedule by nearly two weeks.",
  "A revised transit map was posted at every station along the northern line.",
  "The committee postponed its vote pending further budget analysis.",
  "New signage improved wayfinding throughout the convention center.",
  "The research team calibrated their instruments before the field survey began.",
  "Freight volumes at the port increased modestly compared with the prior year.",
  "The orchestra rehearsed the final movement twice before the evening performance.",
];

/**
 * Build deterministic filler text of roughly `targetChars` characters.
 * Sentence order is seeded so every run produces identical text.
 */
export function buildHaystack(targetChars: number, seed: number = RETRIEVAL_SEED): string {
  const rand = seededRandom(seed);
  const parts: string[] = [];
  let len = 0;
  while (len < targetChars) {
    const s = FILLER_SENTENCES[Math.floor(rand() * FILLER_SENTENCES.length)];
    parts.push(s);
    len += s.length + 1;
  }
  return parts.join(" ");
}

/**
 * Insert the needle at a percentage depth into the haystack, snapped to a
 * sentence boundary so the needle is never split mid-sentence.
 */
export function insertNeedle(haystack: string, needle: string, depthPercent: number): string {
  const clamped = Math.max(0, Math.min(100, depthPercent));
  if (clamped === 0) return `${needle} ${haystack}`;
  if (clamped === 100) return `${haystack} ${needle}`;
  const target = Math.floor((haystack.length * clamped) / 100);
  let idx = haystack.indexOf(". ", target);
  if (idx < 0) idx = haystack.length - 1;
  const before = haystack.slice(0, idx + 1);
  const after = haystack.slice(idx + 2);
  return `${before} ${needle} ${after}`;
}

export const RETRIEVAL_QUESTION =
  "A secret passphrase of the form word-word-number is hidden in the document above. " +
  "What is the secret passphrase? Reply with the passphrase only.";

export function buildRetrievalPrompt(haystackWithNeedle: string): string {
  return `${haystackWithNeedle}\n\n---\n\n${RETRIEVAL_QUESTION}`;
}

/** Tolerant match: case-insensitive, separators may vary. */
export function answerContainsPassphrase(answer: string, passphrase: string): boolean {
  const [w1, w2, num] = passphrase.split("-");
  const re = new RegExp(`${w1}\\s*[-–—_ ]\\s*${w2}\\s*[-–—_ ]\\s*${num}`, "i");
  return re.test(answer);
}
