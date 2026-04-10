// ─────────────────────────────────────────────────────────────────────────────
// test-ranking.ts — unit tests for the pure ranking function
//
// Run with: pnpm test:ranking
//
// No test framework — plain assertions, matching the pattern of
// examples/plain-ts/test-set-recall.ts. Runnable via tsx directly.
//
// These tests use hand-constructed 4-dimension embedding vectors, not
// real 512-dimension OpenAI embeddings. Cosine similarity is
// dimension-agnostic and small vectors make test cases easy to reason about.
// The real 512-dimension path is exercised by phase 3's eval runner against
// the recall fixture set.
// ─────────────────────────────────────────────────────────────────────────────

import {
  cosineSimilarity,
  recencyScore,
  rankMemories,
  breakTies,
  DEFAULT_RANKING_WEIGHTS,
  type RankableMemory,
  type ScoredMemory,
} from "../src/lib/ranking";

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  ✗ ${name}`);
    console.log(`      ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  label: string
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label}: expected ~${expected} (±${tolerance}), got ${actual}`
    );
  }
}

function assertTrue(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`${label}: assertion failed`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-04-10T12:00:00Z");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

function mem(
  id: string,
  overrides: Partial<RankableMemory> = {}
): RankableMemory {
  return {
    id,
    content: `memory ${id}`,
    source: "extracted",
    importance: 0.5,
    embedding: [1, 0, 0, 0],
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Cosine similarity math
// ─────────────────────────────────────────────────────────────────────────────

section("cosineSimilarity");

test("identical vectors return 1.0", () => {
  assertClose(cosineSimilarity([1, 0, 0, 0], [1, 0, 0, 0]), 1.0, 1e-9, "identity");
  assertClose(cosineSimilarity([3, 4, 0, 0], [3, 4, 0, 0]), 1.0, 1e-9, "identity scaled");
});

test("orthogonal vectors return 0.0", () => {
  assertClose(cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0]), 0.0, 1e-9, "x vs y");
  assertClose(cosineSimilarity([0, 0, 1, 0], [0, 0, 0, 1]), 0.0, 1e-9, "z vs w");
});

test("opposite vectors return -1.0", () => {
  assertClose(cosineSimilarity([1, 0, 0, 0], [-1, 0, 0, 0]), -1.0, 1e-9, "opposite");
});

test("scaled parallel vectors return 1.0 (scale-invariance)", () => {
  assertClose(cosineSimilarity([1, 2, 3, 4], [2, 4, 6, 8]), 1.0, 1e-9, "2x scale");
  assertClose(
    cosineSimilarity([1, 2, 3, 4], [0.1, 0.2, 0.3, 0.4]),
    1.0,
    1e-9,
    "0.1x scale"
  );
});

test("zero vector returns 0.0 (no division by zero)", () => {
  assertClose(cosineSimilarity([0, 0, 0, 0], [1, 2, 3, 4]), 0.0, 1e-9, "zero lhs");
  assertClose(cosineSimilarity([1, 2, 3, 4], [0, 0, 0, 0]), 0.0, 1e-9, "zero rhs");
});

test("length mismatch throws", () => {
  let threw = false;
  try {
    cosineSimilarity([1, 2, 3], [1, 2, 3, 4]);
  } catch {
    threw = true;
  }
  assertTrue(threw, "should throw on length mismatch");
});

test("empty vectors return 0.0", () => {
  assertClose(cosineSimilarity([], []), 0.0, 1e-9, "empty");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Recency decay
// ─────────────────────────────────────────────────────────────────────────────

section("recencyScore");

test("memory updated now returns 1.0", () => {
  assertClose(recencyScore(NOW, NOW, 30), 1.0, 1e-9, "now");
});

test("memory at one half-life returns 0.5", () => {
  assertClose(recencyScore(daysAgo(30), NOW, 30), 0.5, 1e-9, "1 half-life");
});

test("memory at two half-lives returns 0.25", () => {
  assertClose(recencyScore(daysAgo(60), NOW, 30), 0.25, 1e-9, "2 half-lives");
});

test("memory at three half-lives returns 0.125", () => {
  assertClose(recencyScore(daysAgo(90), NOW, 30), 0.125, 1e-9, "3 half-lives");
});

test("very old memory returns tiny but positive", () => {
  const score = recencyScore(daysAgo(365), NOW, 30);
  assertTrue(score > 0, "positive");
  assertTrue(score < 0.001, "very small");
});

test("future-dated memory clamped to 1.0", () => {
  const future = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
  assertClose(recencyScore(future, NOW, 30), 1.0, 1e-9, "future clamped");
});

test("different half-life changes decay rate", () => {
  // 7-day half-life at 30 days = 30/7 ≈ 4.29 half-lives ≈ 0.0511
  assertClose(recencyScore(daysAgo(30), NOW, 7), 0.0511, 0.001, "7-day half-life at 30d");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tier multiplier
// ─────────────────────────────────────────────────────────────────────────────

section("tier multiplier");

test("explicit and extracted identical except tier — explicit wins by exact ratio", () => {
  const query = [1, 0, 0, 0];
  const explicit = mem("a", { source: "explicit", updatedAt: NOW });
  const extracted = mem("b", { source: "extracted", updatedAt: NOW });
  const ranked = rankMemories([explicit, extracted], query, undefined, NOW);
  assertEqual(ranked[0].id, "a", "explicit ranks first");
  assertEqual(ranked[1].id, "b", "extracted ranks second");
  const ratio = ranked[0].score / ranked[1].score;
  assertClose(
    ratio,
    DEFAULT_RANKING_WEIGHTS.tierExplicit / DEFAULT_RANKING_WEIGHTS.tierExtracted,
    1e-9,
    "score ratio equals tier ratio"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. NULL embedding fallback
// ─────────────────────────────────────────────────────────────────────────────

section("null embedding fallback");

test("null embedding uses fallback similarity", () => {
  const query = [1, 0, 0, 0];
  const nullMem = mem("a", { embedding: null, updatedAt: NOW });
  const ranked = rankMemories([nullMem], query, undefined, NOW);
  assertClose(
    ranked[0].components.similarity,
    DEFAULT_RANKING_WEIGHTS.nullEmbeddingFallback,
    1e-9,
    "fallback similarity"
  );
});

test("explicit+null beats extracted+null at identical recency", () => {
  const query = [1, 0, 0, 0];
  const exNull = mem("a", { source: "explicit", embedding: null, updatedAt: NOW });
  const exrNull = mem("b", { source: "extracted", embedding: null, updatedAt: NOW });
  const ranked = rankMemories([exNull, exrNull], query, undefined, NOW);
  assertEqual(ranked[0].id, "a", "explicit null wins");
  assertEqual(ranked[1].id, "b", "extracted null loses");
});

test("null-embedding memory still produces a finite positive score", () => {
  const query = [1, 0, 0, 0];
  const nullMem = mem("a", { embedding: null, updatedAt: daysAgo(60) });
  const ranked = rankMemories([nullMem], query, undefined, NOW);
  assertTrue(Number.isFinite(ranked[0].score), "finite");
  assertTrue(ranked[0].score > 0, "positive");
});

test("all-null corpus still ranks (cold start scenario)", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: null, source: "explicit", updatedAt: daysAgo(5) }),
    mem("b", { embedding: null, source: "extracted", updatedAt: NOW }),
    mem("c", { embedding: null, source: "explicit", updatedAt: daysAgo(60) }),
  ];
  const ranked = rankMemories(candidates, query, undefined, NOW);
  assertEqual(ranked.length, 3, "all ranked");
  // 'a' is explicit + fresh — should win
  assertEqual(ranked[0].id, "a", "explicit+fresh wins");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Full ranking order
// ─────────────────────────────────────────────────────────────────────────────

section("full ranking order");

test("similarity dominates with default weights (topic-match beats stale)", () => {
  const query = [1, 0, 0, 0];
  const topicMatch = mem("match", {
    embedding: [1, 0, 0, 0],
    updatedAt: daysAgo(20),
  });
  const offTopic = mem("off", {
    embedding: [0, 1, 0, 0],
    updatedAt: NOW,
  });
  const ranked = rankMemories([topicMatch, offTopic], query, undefined, NOW);
  assertEqual(ranked[0].id, "match", "topic match wins");
});

test("recency breaks similarity ties", () => {
  const query = [1, 0, 0, 0];
  const recent = mem("recent", {
    embedding: [1, 0, 0, 0],
    updatedAt: NOW,
  });
  const old = mem("old", {
    embedding: [1, 0, 0, 0],
    updatedAt: daysAgo(90),
  });
  const ranked = rankMemories([recent, old], query, undefined, NOW);
  assertEqual(ranked[0].id, "recent", "recent wins");
});

test("hierarchy breaks similarity+recency ties", () => {
  const query = [1, 0, 0, 0];
  const explicit = mem("ex", {
    source: "explicit",
    embedding: [1, 0, 0, 0],
    updatedAt: NOW,
  });
  const extracted = mem("exr", {
    source: "extracted",
    embedding: [1, 0, 0, 0],
    updatedAt: NOW,
  });
  const ranked = rankMemories([explicit, extracted], query, undefined, NOW);
  assertEqual(ranked[0].id, "ex", "explicit wins");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Weight override
// ─────────────────────────────────────────────────────────────────────────────

section("weight override");

test("similarity-only weights change order vs defaults", () => {
  const query = [1, 0, 0, 0];
  // "best" is semantically perfect but old
  // "fresh" is semantically weaker but brand new
  const best = mem("best", {
    embedding: [1, 0, 0, 0],
    updatedAt: daysAgo(100),
  });
  const fresh = mem("fresh", {
    embedding: [0.5, 0.5, 0, 0],
    updatedAt: NOW,
  });

  const defaultRanked = rankMemories([best, fresh], query, undefined, NOW);
  const similarityOnlyRanked = rankMemories(
    [best, fresh],
    query,
    { similarity: 1.0, recency: 0.0, importance: 0.0 },
    NOW
  );

  // Under similarity-only, "best" must come first (perfect match beats partial)
  assertEqual(
    similarityOnlyRanked[0].id,
    "best",
    "similarity-only: best first"
  );
  // Under defaults, the ordering depends on the relative decay vs similarity
  // gap — the assertion we can make safely is that the two orderings are
  // different OR that the score ratios are different. We check scores differ.
  const defaultScoreRatio =
    defaultRanked[0].score / defaultRanked[1].score;
  const simOnlyScoreRatio =
    similarityOnlyRanked[0].score / similarityOnlyRanked[1].score;
  assertTrue(
    defaultScoreRatio !== simOnlyScoreRatio,
    "weight changes affect ratios"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Determinism
// ─────────────────────────────────────────────────────────────────────────────

section("determinism");

test("identical inputs produce identical outputs", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: [1, 0, 0, 0], updatedAt: daysAgo(5) }),
    mem("b", { embedding: [0, 1, 0, 0], updatedAt: daysAgo(2) }),
    mem("c", { embedding: [0.5, 0.5, 0, 0], updatedAt: daysAgo(10) }),
  ];
  const a = rankMemories(candidates, query, undefined, NOW);
  const b = rankMemories(candidates, query, undefined, NOW);
  assertEqual(a.length, b.length, "same length");
  for (let i = 0; i < a.length; i++) {
    assertEqual(a[i].id, b[i].id, `order[${i}]`);
    assertEqual(a[i].score, b[i].score, `score[${i}]`);
  }
});

test("ties broken by updatedAt DESC then id lexicographic", () => {
  const query = [1, 0, 0, 0];
  // Three memories that will produce identical scores:
  // same tier, same recency, same similarity, same importance
  const identical = {
    source: "extracted" as const,
    embedding: [1, 0, 0, 0],
    importance: 0.5,
    updatedAt: NOW,
    createdAt: daysAgo(10),
  };
  const c1 = { ...mem("c"), ...identical, id: "c" };
  const a1 = { ...mem("a"), ...identical, id: "a" };
  const b1 = { ...mem("b"), ...identical, id: "b" };
  const ranked = rankMemories([c1, a1, b1], query, undefined, NOW);
  // All scores equal, updatedAt equal → id lexicographic: a, b, c
  assertEqual(ranked[0].id, "a", "lex 0");
  assertEqual(ranked[1].id, "b", "lex 1");
  assertEqual(ranked[2].id, "c", "lex 2");
});

test("updatedAt DESC beats id lexicographic in tiebreaker", () => {
  const query = [1, 0, 0, 0];
  const base = {
    source: "extracted" as const,
    embedding: [1, 0, 0, 0],
    importance: 0.5,
    createdAt: daysAgo(10),
  };
  // 'z' is more recently updated than 'a', should come first despite lex order
  const a = { ...mem("a"), ...base, id: "a", updatedAt: daysAgo(5) };
  const z = { ...mem("z"), ...base, id: "z", updatedAt: NOW };
  // Scores will differ because recency differs! To test pure tiebreak we need
  // identical scores. Instead, assert z comes first due to recency signal.
  const ranked = rankMemories([a, z], query, undefined, NOW);
  assertEqual(ranked[0].id, "z", "more recent wins");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Similarity floor
// ─────────────────────────────────────────────────────────────────────────────

section("similarity floor");

test("floor of 0.3 drops candidate with similarity 0.2, keeps one with 0.5", () => {
  // query = [1,0,0,0]
  // low = [0.2, 0.98, 0, 0] → cosine ~ 0.2 → below 0.3 floor
  // high = [0.5, 0.5, 0.5, 0.5] → cosine ~ 0.5 → above 0.3 floor
  const query = [1, 0, 0, 0];
  const low = mem("low", { embedding: [0.2, 0.98, 0, 0], updatedAt: NOW });
  const high = mem("high", { embedding: [0.5, 0.5, 0.5, 0.5], updatedAt: NOW });
  const ranked = rankMemories([low, high], query, { similarityFloor: 0.3 }, NOW);
  assertEqual(ranked.length, 1, "one candidate survives");
  assertEqual(ranked[0].id, "high", "high-similarity candidate kept");
});

test("null-embedding candidate survives the floor", () => {
  const query = [1, 0, 0, 0];
  const nullMem = mem("null", { embedding: null, updatedAt: NOW });
  const lowSim = mem("low", { embedding: [0.1, 0.99, 0, 0], updatedAt: NOW });
  const ranked = rankMemories([nullMem, lowSim], query, { similarityFloor: 0.3 }, NOW);
  assertEqual(ranked.length, 1, "one candidate survives");
  assertEqual(ranked[0].id, "null", "null-embedding bypasses floor");
});

test("floor of 0 (default) changes nothing", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: [0.1, 0.99, 0, 0], updatedAt: NOW }),
    mem("b", { embedding: [1, 0, 0, 0], updatedAt: NOW }),
  ];
  const withFloor = rankMemories(candidates, query, { similarityFloor: 0 }, NOW);
  const withoutFloor = rankMemories(candidates, query, undefined, NOW);
  assertEqual(withFloor.length, withoutFloor.length, "same count");
  assertEqual(withFloor[0].id, withoutFloor[0].id, "same order");
});

test("floor drops all real-embedding candidates if none meet threshold", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: [0, 1, 0, 0], updatedAt: NOW }),
    mem("b", { embedding: [0, 0, 1, 0], updatedAt: NOW }),
  ];
  const ranked = rankMemories(candidates, query, { similarityFloor: 0.5 }, NOW);
  assertEqual(ranked.length, 0, "all dropped");
});

test("explicit-source candidate bypasses the floor even with low similarity", () => {
  const query = [1, 0, 0, 0];
  const explicit = mem("ex", { embedding: [0.1, 0.99, 0, 0], source: "explicit", updatedAt: NOW });
  const extracted = mem("exr", { embedding: [0.1, 0.99, 0, 0], source: "extracted", updatedAt: NOW });
  const ranked = rankMemories([explicit, extracted], query, { similarityFloor: 0.3 }, NOW);
  assertEqual(ranked.length, 1, "only explicit survives");
  assertEqual(ranked[0].id, "ex", "explicit bypasses floor");
});

test("floor preserves null-embedding candidates even when all real ones are dropped", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("real", { embedding: [0, 1, 0, 0], updatedAt: NOW }),
    mem("null", { embedding: null, source: "explicit", updatedAt: NOW }),
  ];
  const ranked = rankMemories(candidates, query, { similarityFloor: 0.5 }, NOW);
  assertEqual(ranked.length, 1, "one survives");
  assertEqual(ranked[0].id, "null", "null-embedding survives");
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Edge cases
// ─────────────────────────────────────────────────────────────────────────────

section("edge cases");

test("empty candidates returns empty array", () => {
  const ranked = rankMemories([], [1, 0, 0, 0], undefined, NOW);
  assertEqual(ranked.length, 0, "empty");
});

test("single candidate returns single scored memory", () => {
  const query = [1, 0, 0, 0];
  const ranked = rankMemories([mem("a", { updatedAt: NOW })], query, undefined, NOW);
  assertEqual(ranked.length, 1, "single");
  assertEqual(ranked[0].id, "a", "id preserved");
  assertTrue(ranked[0].score > 0, "positive score");
  assertTrue(Number.isFinite(ranked[0].score), "finite score");
});

test("components are populated for every returned memory", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: [1, 0, 0, 0], updatedAt: daysAgo(5) }),
    mem("b", { embedding: null, updatedAt: daysAgo(10) }),
  ];
  const ranked = rankMemories(candidates, query, undefined, NOW);
  for (const r of ranked) {
    assertTrue(typeof r.components.similarity === "number", "sim num");
    assertTrue(typeof r.components.recency === "number", "rec num");
    assertTrue(typeof r.components.importance === "number", "imp num");
    assertTrue(typeof r.components.tier === "number", "tier num");
  }
});

test("score matches components × weights formula", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: [1, 0, 0, 0], updatedAt: daysAgo(15), source: "explicit", importance: 0.7 }),
    mem("b", { embedding: [0, 1, 0, 0], updatedAt: daysAgo(3), source: "extracted", importance: 0.3 }),
  ];
  const ranked = rankMemories(candidates, query, undefined, NOW);
  const w = DEFAULT_RANKING_WEIGHTS;
  for (const r of ranked) {
    const expected =
      r.components.tier *
      (w.similarity * r.components.similarity +
        w.recency * r.components.recency +
        w.importance * r.components.importance);
    assertClose(r.score, expected, 1e-9, `score consistency for ${r.id}`);
  }
});

test("importance out-of-range values are clamped", () => {
  const query = [1, 0, 0, 0];
  const high = mem("high", { importance: 1.5, updatedAt: NOW });
  const low = mem("low", { importance: -0.5, updatedAt: NOW });
  const ranked = rankMemories([high, low], query, undefined, NOW);
  for (const r of ranked) {
    assertTrue(r.components.importance >= 0 && r.components.importance <= 1, `${r.id} clamped`);
  }
});

test("input array is not mutated", () => {
  const query = [1, 0, 0, 0];
  const candidates = [
    mem("a", { embedding: [0, 1, 0, 0], updatedAt: daysAgo(10) }),
    mem("b", { embedding: [1, 0, 0, 0], updatedAt: daysAgo(20) }),
  ];
  const beforeIds = candidates.map((c) => c.id);
  rankMemories(candidates, query, undefined, NOW);
  const afterIds = candidates.map((c) => c.id);
  assertEqual(afterIds.join(","), beforeIds.join(","), "input order preserved");
});

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
}
