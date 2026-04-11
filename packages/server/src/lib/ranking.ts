// ─────────────────────────────────────────────────────────────────────────────
// ranking.ts — pure ranking function for recall
//
// This file implements the scoring and ordering logic for memory recall.
// It is deliberately runtime-agnostic: no DB access, no network calls, no
// Web Crypto, no `process.env`, no `fetch`. It runs identically under
// workerd (in the deployed Worker via recall.ts) and under Node (in the
// eval harness via the recall eval runner). Cross-runtime verification is
// enforced by test discipline, not by file location.
//
// The function takes a list of candidate memories, a query embedding, and
// (optionally) a weight override and a frozen clock, and returns the same
// candidates scored and sorted descending by score. Ties broken by
// updatedAt DESC then id lexicographic.
//
// Callers are responsible for:
//   - Fetching candidate memories from the DB (two-stage: HNSW ANN for
//     extracted with embeddings, plain SELECT for explicit without)
//   - Generating the query embedding via OpenAI
//   - Applying the token-budget trim loop to the returned scored list
//
// See CLAUDE.md for the design rationale.
// ─────────────────────────────────────────────────────────────────────────────

export type RankableMemory = {
  id: string;
  content: string;
  source: "explicit" | "extracted";
  importance: number;
  embedding: number[] | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RankingWeights = {
  /** Weight applied to cosine similarity between query and memory embedding. */
  similarity: number;
  /** Weight applied to the exponential recency decay. */
  recency: number;
  /** Weight applied to the memory's stored importance value. */
  importance: number;
  /** Half-life in days for the recency decay: exp(-age_days / halfLife * ln2). */
  recencyHalfLifeDays: number;
  /** Multiplier applied to the full weighted sum for explicit memories. */
  tierExplicit: number;
  /** Multiplier applied to the full weighted sum for extracted memories. */
  tierExtracted: number;
  /** Similarity score assigned to memories with a null embedding. */
  nullEmbeddingFallback: number;
  /**
   * Minimum cosine similarity for candidates with real embeddings. Candidates
   * below this threshold are excluded before scoring. Does NOT apply to
   * null-embedding candidates (they have no real similarity signal).
   * Default: 0 (no filtering).
   */
  similarityFloor: number;
};

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  similarity: 0.6,
  recency: 0.3,
  importance: 0.1,
  recencyHalfLifeDays: 30,
  tierExplicit: 1.0,
  tierExtracted: 0.7,
  nullEmbeddingFallback: 0.5,
  similarityFloor: 0,
};

export type ScoreComponents = {
  similarity: number;
  recency: number;
  importance: number;
  tier: number;
};

export type ScoredMemory = RankableMemory & {
  score: number;
  components: ScoreComponents;
};

/**
 * Cosine similarity between two equal-length numeric vectors.
 * Returns a value in [-1, 1]. Clamped to 0 at the low end by the caller
 * (rankMemories) before being used as a score signal, because negative
 * similarity shouldn't contribute positively to ranking.
 *
 * Throws if vectors have different lengths — this is a caller bug, not
 * user input, and silently truncating would mask a real error.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`
    );
  }
  if (a.length === 0) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}

/**
 * Exponential recency decay with a configurable half-life.
 *
 * A memory updated exactly now returns 1.0.
 * A memory updated exactly one half-life ago returns 0.5.
 * A memory updated exactly two half-lives ago returns 0.25.
 *
 * Never returns a negative value. Future-dated memories (updatedAt > now)
 * are clamped to 1.0 — this shouldn't happen in practice but prevents
 * clock-skew or fixture-seeding edge cases from producing scores > 1.
 */
export function recencyScore(
  updatedAt: Date,
  now: Date,
  halfLifeDays: number
): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const ageDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / msPerDay);
  const ln2 = Math.log(2);
  return Math.exp((-ageDays / halfLifeDays) * ln2);
}

/**
 * Tie-breaking comparator for memories with equal scores.
 * Primary: updatedAt DESC (more recently updated first).
 * Secondary: id lexicographic ASC (for full determinism).
 *
 * Named and exported so it's a one-line change to swap tiebreakers later.
 */
export function breakTies(a: ScoredMemory, b: ScoredMemory): number {
  const timeDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Rank a list of candidate memories against a query embedding.
 *
 * Pure function: no DB access, no network calls, no reliance on
 * `Date.now()` internally (uses the injected `now` parameter).
 *
 * Returns a new array sorted descending by computed score, ties broken
 * by `breakTies`. The input array is not mutated.
 *
 * @param candidates  List of memories to rank. Empty input returns empty output.
 * @param queryEmbedding  Embedding of the recall query (same model/dims as stored).
 * @param weights  Partial override of the default weights.
 * @param now  Frozen clock for testing. Defaults to new Date() at call time.
 */
export function rankMemories(
  candidates: RankableMemory[],
  queryEmbedding: number[],
  weights?: Partial<RankingWeights>,
  now: Date = new Date()
): ScoredMemory[] {
  if (candidates.length === 0) {
    return [];
  }

  const w: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS, ...weights };

  // First pass: compute similarity and apply the floor filter.
  // Candidates with real embeddings below the floor are excluded.
  // Null-embedding candidates bypass the floor (no real similarity signal).
  const withSimilarity: { mem: RankableMemory; similarity: number }[] = [];
  for (const mem of candidates) {
    let similarity: number;
    if (mem.embedding === null) {
      similarity = w.nullEmbeddingFallback;
    } else {
      const raw = cosineSimilarity(queryEmbedding, mem.embedding);
      similarity = Math.max(0, Math.min(1, raw));
      if (w.similarityFloor > 0 && similarity < w.similarityFloor) {
        continue; // below floor — exclude
      }
    }
    withSimilarity.push({ mem, similarity });
  }

  // Second pass: score survivors.
  const scored: ScoredMemory[] = withSimilarity.map(({ mem, similarity }) => {
    // Recency component — always in [0, 1].
    const recency = recencyScore(mem.updatedAt, now, w.recencyHalfLifeDays);

    // Importance component — clamped to [0, 1] in case of out-of-range
    // values in the DB (shouldn't happen but cheap insurance).
    const importance = Math.max(0, Math.min(1, mem.importance));

    // Tier multiplier — discrete per source.
    const tier = mem.source === "explicit" ? w.tierExplicit : w.tierExtracted;

    // Weighted sum, then tier multiplier.
    const weightedSum =
      w.similarity * similarity + w.recency * recency + w.importance * importance;
    const score = tier * weightedSum;

    return {
      ...mem,
      score,
      components: { similarity, recency, importance, tier },
    };
  });

  // Sort descending by score, ties broken by breakTies.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return breakTies(a, b);
  });

  return scored;
}
