import { Hono } from "hono";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { isNull } from "drizzle-orm/sql/expressions/conditions";
import * as schema from "../../db/schema";
import {
  SCOPE_MAX_LENGTH,
  normalizeParams,
  setDeprecationHeader,
} from "../../lib/validation";
import type { WorkerEnv, AppVariables } from "../../types";
import { embedQuery, EMBEDDING_DIMENSIONS } from "../../lib/embeddings";
import {
  rankMemories,
  type RankableMemory,
  type RankingWeights,
} from "../../lib/ranking";

const { wmEndUsers, wmMemories } = schema;

// ─────────────────────────────────────────────────────────────────────────────
// Request validation
// ─────────────────────────────────────────────────────────────────────────────

const RecallRequestSchema = z.object({
  forScope: z.string().min(1).max(SCOPE_MAX_LENGTH),
  query: z.string().min(1).max(8192),
  maxItems: z.number().int().min(1).max(50).optional(),
  maxTokens: z.number().int().min(10).max(2000).optional(),
  defaults: z.record(z.string(), z.string()).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback ranking weights for the embedding-unavailable path.
//
// When OpenAI embeddings fail, we can't compute semantic similarity. The
// ranking function is still called, with similarity forced to 0 (both as a
// weight and as the null-embedding fallback constant), so every memory is
// effectively ranked by tier × (0.75 × recency + 0.25 × importance). Recency
// is weighted 3x importance because "most recent" is almost always a stronger
// signal than "most important" when we've lost similarity.
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_WEIGHTS: Partial<RankingWeights> = {
  similarity: 0,
  recency: 0.75,
  importance: 0.25,
  nullEmbeddingFallback: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Response envelope types
// ─────────────────────────────────────────────────────────────────────────────

type RankingStrategy = "semantic" | "recency_importance" | "user_not_found";

type RankingEnvelope = {
  strategy: RankingStrategy;
  reason?: "embedding_unavailable";
};

// ─────────────────────────────────────────────────────────────────────────────
// pgvector query candidate pool size
//
// HNSW index quality degrades below ~50 candidates because ANN needs enough
// neighborhood to rerank from. For typical recall calls with maxItems=4,
// this means the pool is 50. For power users with maxItems=50, the pool is
// 500. Configurable later if fixture data shows pool size affects quality;
// hardcoded for phase 2b.
// ─────────────────────────────────────────────────────────────────────────────

function candidatePoolSize(resolvedMaxItems: number): number {
  return Math.max(50, resolvedMaxItems * 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping helpers
//
// The pgvector query (Query A) uses db.execute(sql`...`) which returns raw
// postgres-js rows with snake_case keys. Query B and Query C use Drizzle's
// query builder which returns camelCase. Both paths converge to the same
// RankableMemory shape for ranking.
// ─────────────────────────────────────────────────────────────────────────────

type RawEmbeddedRow = {
  id: string;
  content: string;
  source: "explicit" | "extracted";
  importance: number | string; // postgres-js may return numeric types as strings from raw sql
  embedding: string | null; // postgres-js returns vector as a string literal
  created_at: string | Date; // postgres-js returns timestamps as strings from raw sql
  updated_at: string | Date;
  key: string | null;
};

function parseVectorLiteral(value: string | null): number[] | null {
  if (value === null) return null;
  // Vector literals come back as "[0.123,-0.456,...]"
  const inner = value.slice(1, -1);
  if (inner.length === 0) return [];
  return inner.split(",").map((n) => Number.parseFloat(n));
}

function mapRawRowToRankable(row: RawEmbeddedRow): RankableMemory {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    importance: typeof row.importance === "string" ? Number.parseFloat(row.importance) : row.importance,
    embedding: parseVectorLiteral(row.embedding),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

function mapDrizzleRowToRankable(
  row: typeof wmMemories.$inferSelect
): RankableMemory {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    importance: row.importance,
    embedding: row.embedding,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Drizzle row also carries `key` which the prompt block formatter needs,
// but RankableMemory doesn't include it. We keep a parallel Map from id to
// key so we can look it up after ranking.
function extractKeyMap(
  extractedRows: RawEmbeddedRow[],
  nullEmbeddingRows: (typeof wmMemories.$inferSelect)[]
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const r of extractedRows) {
    map.set(r.id, r.key);
  }
  for (const r of nullEmbeddingRows) {
    map.set(r.id, r.key);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

export function recallRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/recall", async (c) => {
    const rawBody = await c.req.json();
    const { normalized, warnings } = normalizeParams(rawBody, ["userId", "input"]);
    setDeprecationHeader(c, warnings);

    const parsed = RecallRequestSchema.safeParse(normalized);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid request body",
            details: parsed.error.issues,
          },
        },
        400
      );
    }

    const db = c.get("db");
    const account = c.get("account");
    const { forScope, query, maxItems, maxTokens, defaults } = parsed.data;

    const resolvedMaxItems = maxItems ?? 4;
    const resolvedMaxTokens = maxTokens ?? 150;
    const maxChars = resolvedMaxTokens * 4;

    // ─── Step 1: End-user lookup ──────────────────────────────────────────
    const [endUser] = await db
      .select()
      .from(wmEndUsers)
      .where(
        and(
          eq(wmEndUsers.accountId, account.id),
          eq(wmEndUsers.externalId, forScope)
        )
      )
      .limit(1);

    // ─── Step 2: user_not_found early return ──────────────────────────────
    // End user doesn't exist under this account. No memories to rank against.
    // Fall through to defaults-only prompt block if defaults were provided,
    // otherwise return an empty envelope. Ranker is not called.
    if (!endUser) {
      const defaultLines: string[] = [];
      if (defaults && Object.keys(defaults).length > 0) {
        for (const [k, v] of Object.entries(defaults)) {
          if (defaultLines.length >= resolvedMaxItems) break;
          const line = `${k}: ${v}`;
          if ([...defaultLines, line].join("\n").length > maxChars) break;
          defaultLines.push(line);
        }
      }
      const ranking: RankingEnvelope = { strategy: "user_not_found" };
      return c.json({
        context: defaultLines.join("\n"),
        memories: [],
        ranking,
      });
    }

    // ─── Step 3: Attempt query embedding ──────────────────────────────────
    let queryEmbedding: number[] | null = null;
    let strategy: RankingStrategy = "semantic";
    let reason: "embedding_unavailable" | undefined = undefined;

    const apiKey = c.env.OPENAI_API_KEY;
    if (!apiKey) {
      // No key configured — treat as an embedding failure and fall through
      // to the fallback path. This is the cleanest handling for a
      // misconfigured Worker: degrade gracefully instead of 500ing.
      console.warn(
        `recall: OPENAI_API_KEY not configured, using fallback ranking (account=${account.id})`
      );
      strategy = "recency_importance";
      reason = "embedding_unavailable";
    } else {
      try {
        queryEmbedding = await embedQuery(apiKey, query);
      } catch (err) {
        console.warn(
          `recall: embedding failed, using fallback ranking (account=${account.id}): ${
            err instanceof Error ? err.message : "unknown error"
          }`
        );
        strategy = "recency_importance";
        reason = "embedding_unavailable";
      }
    }

    // ─── Step 4: Fetch candidates ─────────────────────────────────────────
    let candidates: RankableMemory[] = [];
    const keyMap = new Map<string, string | null>();

    if (strategy === "semantic" && queryEmbedding) {
      // Semantic path: two-stage fetch
      // Query A — extracted memories with embeddings via pgvector ANN
      const queryVectorLiteral = `[${queryEmbedding.join(",")}]`;
      const poolSize = candidatePoolSize(resolvedMaxItems);

      const extractedResult = await db.execute(sql`
        SELECT
          id,
          content,
          source,
          importance,
          embedding::text AS embedding,
          created_at,
          updated_at,
          key
        FROM wm_memories
        WHERE account_id = ${account.id}
          AND end_user_id = ${endUser.id}
          AND embedding IS NOT NULL
          AND superseded_by IS NULL
          AND status = 'ready'
        ORDER BY embedding <=> ${queryVectorLiteral}::vector
        LIMIT ${poolSize};
      `);

      const extractedRows = extractedResult as unknown as RawEmbeddedRow[];

      // Query B — null-embedding memories (explicit set() without embedding)
      const nullEmbeddingRows = await db
        .select()
        .from(wmMemories)
        .where(
          and(
            eq(wmMemories.accountId, account.id),
            eq(wmMemories.endUserId, endUser.id),
            isNull(wmMemories.embedding),
            isNull(wmMemories.supersededBy),
            eq(wmMemories.status, "ready")
          )
        );

      // Build the key lookup map from both sources
      for (const [id, key] of extractKeyMap(extractedRows, nullEmbeddingRows)) {
        keyMap.set(id, key);
      }

      // Combine into the ranking input
      candidates = [
        ...extractedRows.map(mapRawRowToRankable),
        ...nullEmbeddingRows.map(mapDrizzleRowToRankable),
      ];
    } else {
      // Fallback path: single-stage fetch of all non-superseded ready memories
      // regardless of embedding status. Query C.
      const allRows = await db
        .select()
        .from(wmMemories)
        .where(
          and(
            eq(wmMemories.accountId, account.id),
            eq(wmMemories.endUserId, endUser.id),
            isNull(wmMemories.supersededBy),
            eq(wmMemories.status, "ready")
          )
        );

      for (const r of allRows) {
        keyMap.set(r.id, r.key);
      }
      candidates = allRows.map(mapDrizzleRowToRankable);
    }

    // ─── Step 5: Rank ─────────────────────────────────────────────────────
    // In the semantic path, use the real query embedding and default weights.
    // In the fallback path, use a zero vector (never actually consulted
    // because similarity weight is 0) and the fallback weights.
    const rankingInputEmbedding: number[] =
      queryEmbedding ?? new Array(EMBEDDING_DIMENSIONS).fill(0);
    const weights =
      strategy === "semantic"
        ? { similarityFloor: 0.2 }
        : FALLBACK_WEIGHTS;

    const ranked = rankMemories(
      candidates,
      rankingInputEmbedding,
      weights,
      new Date()
    );

    // ─── Step 6: Top-K slice ──────────────────────────────────────────────
    const topK = ranked.slice(0, resolvedMaxItems);

    // ─── Step 7: Token-budget trim loop ───────────────────────────────────
    // Format each memory as "key: content" or just "content" for null-key
    // extracted memories. Pop from the end until the joined string fits.
    const formatted = topK.map((m) => {
      const key = keyMap.get(m.id);
      return key ? `${key}: ${m.content}` : m.content;
    });

    const kept = [...formatted];
    const keptRows = [...topK];
    while (kept.join("\n").length > maxChars && kept.length > 0) {
      kept.pop();
      keptRows.pop();
    }

    // Tier 4: append registered defaults if there's headroom
    if (defaults && Object.keys(defaults).length > 0 && kept.length < resolvedMaxItems) {
      for (const [k, v] of Object.entries(defaults)) {
        if (kept.length >= resolvedMaxItems) break;
        const line = `${k}: ${v}`;
        if ([...kept, line].join("\n").length > maxChars) break;
        kept.push(line);
      }
    }

    const context = kept.join("\n");

    // ─── Step 8: Build response envelope ──────────────────────────────────
    const ranking: RankingEnvelope = { strategy };
    if (reason) ranking.reason = reason;

    return c.json({
      context,
      memories: keptRows.map((m) => ({
        id: m.id,
        forScope,
        forKey: keyMap.get(m.id) ?? null,
        value: m.content,
        source: m.source,
        status: "ready" as const,
        statusError: null,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      ranking,
    });
  });

  return app;
}
