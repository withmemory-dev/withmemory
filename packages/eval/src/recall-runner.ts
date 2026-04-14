/**
 * Recall eval harness.
 *
 * Runs the pure ranking function against labeled recall fixtures and reports
 * quality metrics. No DB, no HTTP — only real OpenAI embedding calls and the
 * in-memory rankMemories function.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... pnpm --filter @withmemory/eval test:recall-eval
 *   OPENAI_API_KEY=sk-... pnpm --filter @withmemory/eval test:recall-baseline
 */

import { embedTexts } from "@withmemory/server/src/lib/embeddings";
import {
  rankMemories,
  type RankableMemory,
  type ScoredMemory,
} from "@withmemory/server/src/lib/ranking";
import { recallEvalFixtures, type RecallFixture } from "../fixtures/recall-v1";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is required.");
  process.exit(1);
}

const BASELINE_MODE = process.argv.includes("--baseline");

// Similarity floor passed to rankMemories on the semantic path.
// Override via --floor=0.3 on the command line for tuning.
const floorArg = process.argv.find((a) => a.startsWith("--floor="));
const SIMILARITY_FLOOR = floorArg ? parseFloat(floorArg.split("=")[1]) : 0.2;

// ─── Embedding cache ────────────────────────────────────────────────────────

const embeddingCache = new Map<string, number[]>();
let totalEmbedded = 0;
let cacheHits = 0;

/**
 * Embed a batch of texts, using the cache for any previously seen strings.
 * Only sends uncached texts to OpenAI, then merges results back.
 */
async function embedWithCache(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = embeddingCache.get(texts[i]);
    if (cached) {
      results[i] = cached;
      cacheHits++;
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]);
    }
  }

  if (uncachedTexts.length > 0) {
    const fresh = await embedTexts(OPENAI_API_KEY!, uncachedTexts);
    totalEmbedded += uncachedTexts.length;
    for (let j = 0; j < uncachedTexts.length; j++) {
      const embedding = fresh[j];
      if (embedding) {
        embeddingCache.set(uncachedTexts[j], embedding);
      }
      results[uncachedIndices[j]] = embedding;
    }
  }

  return results;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

interface FixtureResult {
  fixture: RecallFixture;
  topKIds: number[]; // corpus indices in ranked order
  pass: boolean;
  precision: number;
  recall: number;
  mustExcludeViolations: number;
  error: string | null;
}

function scoreResult(fixture: RecallFixture, topKIds: number[]): Omit<FixtureResult, "error"> {
  const { mustInclude, mustExclude } = fixture.expected;

  // Recall: fraction of mustInclude items present in top-K
  let recall = 1.0;
  if (mustInclude.length > 0) {
    const found = mustInclude.filter((idx) => topKIds.includes(idx)).length;
    recall = found / mustInclude.length;
  }

  // Precision: fraction of top-K results that are in mustInclude
  let precision = 1.0;
  if (mustInclude.length > 0 && topKIds.length > 0) {
    const relevant = topKIds.filter((idx) => mustInclude.includes(idx)).length;
    precision = relevant / topKIds.length;
  }

  // mustExclude violations
  const violations = mustExclude ? topKIds.filter((idx) => mustExclude.includes(idx)).length : 0;

  const pass = recall === 1.0 && violations === 0;

  return { fixture, topKIds, pass, precision, recall, mustExcludeViolations: violations };
}

// ─── Per-fixture evaluation ─────────────────────────────────────────────────

async function evaluateFixture(fixture: RecallFixture, now: Date): Promise<FixtureResult> {
  const topK = fixture.expected.topK ?? 4;
  const isNullEmbeddingFixture = fixture.tags?.includes("null_embedding") ?? false;

  // Collect all texts to embed: corpus contents + query
  const allTexts = [...fixture.corpus.map((c) => c.content), fixture.query];

  // Embed everything
  const embeddings = await embedWithCache(allTexts);

  const queryEmbedding = embeddings[fixture.corpus.length];
  if (!queryEmbedding) {
    return {
      fixture,
      topKIds: [],
      pass: false,
      precision: 0,
      recall: 0,
      mustExcludeViolations: 0,
      error: "Failed to embed query text",
    };
  }

  // Build RankableMemory[] from corpus
  const candidates: RankableMemory[] = fixture.corpus.map((item, i) => {
    const dateMs = now.getTime() - item.daysOld * 86400000;
    const date = new Date(dateMs);

    // Null-embedding fixtures: explicit-source items get null embedding
    let embedding = embeddings[i];
    if (isNullEmbeddingFixture && item.source === "explicit") {
      embedding = null;
    }

    return {
      id: `mem-${i}`,
      content: item.content,
      source: item.source,
      importance: item.importance ?? 0.5,
      embedding,
      createdAt: date,
      updatedAt: date,
    };
  });

  let ranked: { id: string }[];

  if (BASELINE_MODE) {
    // Baseline: sort by updatedAt DESC (most recent first), slice top-K
    const sorted = [...candidates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    ranked = sorted.slice(0, topK);
  } else {
    // Semantic ranking via the real rankMemories function
    const scored: ScoredMemory[] = rankMemories(
      candidates,
      queryEmbedding,
      { similarityFloor: SIMILARITY_FLOOR },
      now
    );
    ranked = scored.slice(0, topK);
  }

  // Convert mem-N IDs back to corpus indices
  const topKIds = ranked.map((m) => parseInt(m.id.replace("mem-", ""), 10));

  return { ...scoreResult(fixture, topKIds), error: null };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

async function main() {
  const fixtures = recallEvalFixtures;
  const now = new Date();

  const mode = BASELINE_MODE ? "BASELINE (updatedAt DESC)" : "SEMANTIC (rankMemories)";
  console.log(`\nWithMemory Recall Eval Harness`);
  console.log(`Mode: ${mode}`);
  if (!BASELINE_MODE) {
    console.log(`Similarity floor: ${SIMILARITY_FLOOR}`);
  }
  console.log(`Fixtures: ${fixtures.length}\n`);

  const start = performance.now();
  const results: FixtureResult[] = [];

  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture, now);
    results.push(result);

    const icon = result.error ? "!" : result.pass ? "\u2713" : "\u2717";
    const tag = fixture.tags?.[0] ?? "untagged";
    console.log(`${icon} [${tag}] ${fixture.id}: ${fixture.description}`);

    if (!result.pass || result.error) {
      console.log(`    top-K order: [${result.topKIds.join(", ")}]`);
      console.log(
        `    mustInclude: [${fixture.expected.mustInclude.join(", ")}]  mustExclude: [${(fixture.expected.mustExclude ?? []).join(", ")}]`
      );
      if (result.mustExcludeViolations > 0) {
        console.log(`    mustExclude violations: ${result.mustExcludeViolations}`);
      }
      if (result.error) {
        console.log(`    error: ${result.error}`);
      }
    }
  }

  const durationMs = Math.round(performance.now() - start);

  // ── Aggregate metrics ──────────────────────────────────────────────────

  const totalPass = results.filter((r) => r.pass).length;
  const passRate = results.length > 0 ? totalPass / results.length : 0;

  const avgPrecision =
    results.length > 0 ? results.reduce((sum, r) => sum + r.precision, 0) / results.length : 0;
  const avgRecall =
    results.length > 0 ? results.reduce((sum, r) => sum + r.recall, 0) / results.length : 0;

  // MRR: for each fixture, find the rank of the first mustInclude item
  let mrrSum = 0;
  let mrrCount = 0;
  for (const r of results) {
    if (r.fixture.expected.mustInclude.length === 0) continue;
    mrrCount++;
    for (let rank = 0; rank < r.topKIds.length; rank++) {
      if (r.fixture.expected.mustInclude.includes(r.topKIds[rank])) {
        mrrSum += 1 / (rank + 1);
        break;
      }
    }
  }
  const mrr = mrrCount > 0 ? mrrSum / mrrCount : 0;

  // Per-tag breakdown
  const allTags = [...new Set(results.flatMap((r) => r.fixture.tags ?? ["untagged"]))];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  mode:              ${mode}`);
  if (!BASELINE_MODE) {
    console.log(`  similarity_floor:  ${SIMILARITY_FLOOR}`);
  }
  console.log(
    `  pass_rate:         ${totalPass}/${results.length} (${(passRate * 100).toFixed(1)}%)`
  );
  console.log(`  avg_precision:     ${(avgPrecision * 100).toFixed(1)}%`);
  console.log(`  avg_recall:        ${(avgRecall * 100).toFixed(1)}%`);
  console.log(`  mrr:               ${mrr.toFixed(3)}`);

  console.log(`\n  Per-tag breakdown:`);
  for (const tag of allTags) {
    const tagResults = results.filter((r) => (r.fixture.tags ?? ["untagged"]).includes(tag));
    const tagPass = tagResults.filter((r) => r.pass).length;
    console.log(`    ${tag}: ${tagPass}/${tagResults.length} pass`);
  }

  console.log(`\n  Embedding cache:`);
  console.log(`    texts_embedded:  ${totalEmbedded}`);
  console.log(`    cache_hits:      ${cacheHits}`);
  console.log(`    cache_size:      ${embeddingCache.size}`);

  console.log(`\n  total_duration_ms: ${durationMs}`);
  console.log(`${"=".repeat(60)}`);

  // ── List failures ─────────────────────────────────────────────────────

  const failures = results.filter((r) => !r.pass || r.error);
  if (failures.length > 0) {
    console.log(`\n  Failed cases (${failures.length}):`);
    for (const f of failures) {
      console.log(`\n    ${f.fixture.id} [${f.fixture.tags?.[0] ?? "untagged"}]`);
      console.log(`      description:  ${f.fixture.description}`);
      console.log(`      query:        ${f.fixture.query}`);
      console.log(`      top-K:        [${f.topKIds.join(", ")}]`);
      console.log(`      mustInclude:  [${f.fixture.expected.mustInclude.join(", ")}]`);
      console.log(`      mustExclude:  [${(f.fixture.expected.mustExclude ?? []).join(", ")}]`);
      console.log(`      precision:    ${(f.precision * 100).toFixed(1)}%`);
      console.log(`      recall:       ${(f.recall * 100).toFixed(1)}%`);
      console.log(`      violations:   ${f.mustExcludeViolations}`);
      if (f.error) console.log(`      error:        ${f.error}`);

      // Show what each corpus index contains for debugging
      console.log(`      corpus:`);
      for (let i = 0; i < f.fixture.corpus.length; i++) {
        const item = f.fixture.corpus[i];
        const inTopK = f.topKIds.includes(i) ? " *" : "";
        console.log(`        [${i}] (${item.source}, ${item.daysOld}d) ${item.content}${inTopK}`);
      }
    }
  }

  console.log("");
}

main();
