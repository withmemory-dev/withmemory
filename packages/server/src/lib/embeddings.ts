/**
 * OpenAI embeddings helpers.
 *
 * Both the extraction pipeline (lib/extraction.ts) and the recall route
 * (routes/v1/recall.ts) generate embeddings against OpenAI's
 * text-embedding-3-small model at 512 dimensions (Matryoshka truncation).
 * This module is the single source of truth for that API call shape.
 *
 * Runtime-agnostic: uses `fetch` and nothing else. Runs under workerd
 * (deployed Worker) and Node (eval harness, unit tests).
 *
 * Callers are responsible for:
 *   - Supplying the OpenAI API key (from env secrets in the Worker,
 *     from .env.local in the eval harness)
 *   - Handling errors — this module throws on API failure, caller decides
 *     whether to degrade, retry, or propagate
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Dimension count for all embeddings in WithMemory. Matches the pgvector
 * column type `vector(512)` defined in schema.ts. Do not change without
 * a migration to widen the column and a backfill of existing rows.
 */
export const EMBEDDING_DIMENSIONS = 512;

/**
 * Model identifier for all embeddings in WithMemory. Matches the model used
 * at write time by the extraction pipeline, so query embeddings at recall
 * time are in the same vector space as stored memory embeddings.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";

// ─── Batch embedding (used by extraction pipeline) ───────────────────────────

/**
 * Generate embeddings for a batch of texts in a single API call.
 *
 * Returns an array of the same length as `texts`. Each element is either
 * a 512-dimensional number array or `null` if that specific embedding came
 * back malformed (wrong dimension count, missing field). The caller decides
 * how to handle nulls.
 *
 * Throws on full API failure (network error, non-2xx, malformed envelope).
 * Individual-embedding failures produce nulls rather than throwing because
 * the extraction pipeline prefers to persist memories without embeddings
 * rather than drop them entirely.
 */
export async function embedTexts(apiKey: string, texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) {
    return [];
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: texts,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI embeddings API returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as {
    data?: { embedding: number[]; index: number }[];
  };

  if (!body.data || !Array.isArray(body.data)) {
    throw new Error("OpenAI embeddings response missing data array");
  }

  // Sort by index to match input order, validate dimension count
  const sorted = [...body.data].sort((a, b) => a.index - b.index);

  return sorted.map((item) => {
    if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
      return null;
    }
    return item.embedding;
  });
}

// ─── Single-text embedding (used by recall route) ────────────────────────────

/**
 * Generate an embedding for a single text. Wraps `embedTexts` with a
 * one-element array and unwraps the result.
 *
 * Throws on API failure OR if the single embedding comes back null.
 * The recall route catches this and falls back to non-semantic ranking,
 * so the thrown error is the signal that triggers the fallback path.
 */
export async function embedQuery(apiKey: string, text: string): Promise<number[]> {
  const results = await embedTexts(apiKey, [text]);
  const embedding = results[0];
  if (!embedding) {
    throw new Error("OpenAI embeddings returned null for query text");
  }
  return embedding;
}
