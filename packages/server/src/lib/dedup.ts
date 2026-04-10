/**
 * Deduplication and conflict resolution for extracted memories.
 *
 * After extraction produces new facts with embeddings, this module compares
 * each against the user's existing non-superseded memories to decide:
 *   - Near-duplicate (similarity >= 0.92): supersede old, insert new
 *   - Conflict (0.78 <= similarity < 0.92):
 *       - Old is explicit: skip new (explicit wins)
 *       - Old is extracted: supersede old, insert new
 *   - Novel (similarity < 0.78): insert normally
 *
 * Operates entirely in application code — fetches all existing embedded
 * memories for the user once, then compares each new fact via brute-force
 * cosine similarity. For typical user memory counts (< 100), this is fast
 * and simpler than pgvector ANN.
 */

import { cosineSimilarity } from "./ranking";

// ─── Thresholds ─────────────────────────────────────────────────────────────

const NEAR_DUPLICATE_THRESHOLD = 0.92;
const CONFLICT_THRESHOLD = 0.78;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExistingMemory {
  id: string;
  content: string;
  embedding: number[];
  source: "explicit" | "extracted";
  key: string | null;
}

export interface NewFact {
  content: string;
  embedding: number[];
}

export type DedupAction =
  | { type: "insert" }
  | { type: "supersede"; oldMemoryId: string }
  | { type: "skip"; reason: "explicit_conflict"; oldMemoryId: string };

// ─── Core logic ─────────────────────────────────────────────────────────────

/**
 * Determine what to do with a single new extracted fact given the user's
 * existing memories.
 *
 * Pure function: no DB access, no side effects. The caller is responsible
 * for executing the returned action.
 */
export function classifyFact(
  newFact: NewFact,
  existingMemories: ExistingMemory[]
): DedupAction {
  if (existingMemories.length === 0) {
    return { type: "insert" };
  }

  let bestSimilarity = -1;
  let bestMatch: ExistingMemory | null = null;

  for (const existing of existingMemories) {
    const sim = cosineSimilarity(newFact.embedding, existing.embedding);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = existing;
    }
  }

  if (!bestMatch || bestSimilarity < CONFLICT_THRESHOLD) {
    return { type: "insert" };
  }

  if (bestSimilarity >= NEAR_DUPLICATE_THRESHOLD) {
    // Near-duplicate: supersede regardless of source
    return { type: "supersede", oldMemoryId: bestMatch.id };
  }

  // Conflict range: 0.78 <= similarity < 0.92
  if (bestMatch.source === "explicit") {
    // Explicit memories cannot be overwritten by extraction
    return { type: "skip", reason: "explicit_conflict", oldMemoryId: bestMatch.id };
  }

  // Old is extracted: supersede with newer wording
  return { type: "supersede", oldMemoryId: bestMatch.id };
}
