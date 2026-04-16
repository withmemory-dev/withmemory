import { eq, and, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import * as schema from "../db/schema";
import type { WmAccount, WmEndUser } from "../db/schema";
import type { WorkerEnv } from "../types";
import { runExtraction } from "./extraction";
import { classifyFact, type ExistingMemory } from "./dedup";

const { wmExchanges, wmMemories } = schema;

interface AddWithExtractionOptions {
  db: Database;
  env: WorkerEnv;
  account: WmAccount;
  endUser: WmEndUser;
  value: string;
  extractionPrompt: string;
  promptVersion: string | null;
  idempotencyKey?: string;
}

interface AddedMemory {
  id: string;
  scope: string;
  key: string | null;
  value: string;
  source: "extracted";
  status: "ready" | "pending" | "failed";
  statusError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Run LLM extraction on a text value and persist the resulting memories.
 *
 * This helper encapsulates the full extraction pipeline: exchange row creation,
 * LLM call, embedding, dedup classification, and memory insertion. It is
 * runtime-agnostic — no Hono context, no HTTP concepts.
 *
 * The caller is responsible for:
 *   - Quota pre-check (reject before calling this helper)
 *   - Providing the resolved extraction prompt and version
 *   - HTTP response formatting
 */
export async function addWithExtraction(
  options: AddWithExtractionOptions,
  externalId: string
): Promise<AddedMemory[]> {
  const { db, env, account, endUser, value, extractionPrompt, promptVersion, idempotencyKey } =
    options;

  // Idempotency check: return cached memories if exchange already exists
  if (idempotencyKey) {
    const [existing] = await db
      .select({ id: wmExchanges.id })
      .from(wmExchanges)
      .where(
        and(eq(wmExchanges.accountId, account.id), eq(wmExchanges.idempotencyKey, idempotencyKey))
      )
      .limit(1);

    if (existing) {
      // Return memories linked to the existing exchange
      const rows = await db.select().from(wmMemories).where(eq(wmMemories.exchangeId, existing.id));

      return rows.map((r) => ({
        id: r.id,
        scope: externalId,
        key: null,
        value: r.content,
        source: "extracted" as const,
        status: r.status as "ready" | "pending" | "failed",
        statusError: r.statusError,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    }
  }

  // Create exchange row (audit trail — always created, even if extraction produces nothing)
  const [exchange] = await db
    .insert(wmExchanges)
    .values({
      accountId: account.id,
      endUserId: endUser.id,
      input: value,
      idempotencyKey: idempotencyKey?.slice(0, 255) || null,
      promptVersion,
      extractionStatus: "pending",
    })
    .returning();

  // Run extraction
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    await db
      .update(wmExchanges)
      .set({
        extractionStatus: "failed",
        extractionError: "Missing OPENAI_API_KEY",
        extractionCompletedAt: new Date(),
      })
      .where(eq(wmExchanges.id, exchange.id));
    throw new ExtractionError("extraction_failed", "Extraction service unavailable", 500);
  }

  const result = await runExtraction({
    openaiApiKey: apiKey,
    prompt: extractionPrompt,
    promptVersion: promptVersion || "unknown",
    input: value,
  });

  if (result.error && result.memories.length === 0) {
    await db
      .update(wmExchanges)
      .set({
        extractionStatus: "failed",
        extractionError: result.error,
        extractionCompletedAt: new Date(),
      })
      .where(eq(wmExchanges.id, exchange.id));
    throw new ExtractionError("extraction_failed", "Extraction pipeline failed", 500);
  }

  if (result.memories.length === 0) {
    await db
      .update(wmExchanges)
      .set({
        extractionStatus: "skipped",
        extractionCompletedAt: new Date(),
      })
      .where(eq(wmExchanges.id, exchange.id));
    return [];
  }

  // Dedup: fetch existing memories for this user
  const existingRows = await db
    .select({
      id: wmMemories.id,
      content: wmMemories.content,
      embedding: wmMemories.embedding,
      source: wmMemories.source,
      key: wmMemories.key,
    })
    .from(wmMemories)
    .where(
      and(
        eq(wmMemories.accountId, account.id),
        eq(wmMemories.endUserId, endUser.id),
        isNull(wmMemories.supersededBy)
      )
    );

  const existingMemories: ExistingMemory[] = existingRows
    .filter((r) => r.embedding !== null)
    .map((r) => ({
      id: r.id,
      content: r.content,
      embedding: r.embedding as number[],
      source: r.source,
      key: r.key,
    }));

  // Classify and execute each extracted fact
  const addedMemories: AddedMemory[] = [];

  for (const m of result.memories) {
    if (!m.embedding) {
      const [inserted] = await db
        .insert(wmMemories)
        .values({
          accountId: account.id,
          endUserId: endUser.id,
          key: null,
          content: m.content,
          source: "extracted" as const,
          embedding: null,
          exchangeId: exchange.id,
          importance: 0.5,
        })
        .returning();

      addedMemories.push({
        id: inserted.id,
        scope: externalId,
        key: null,
        value: inserted.content,
        source: "extracted",
        status: inserted.status as "ready" | "pending" | "failed",
        statusError: inserted.statusError,
        createdAt: inserted.createdAt.toISOString(),
        updatedAt: inserted.updatedAt.toISOString(),
      });
      continue;
    }

    const action = classifyFact({ content: m.content, embedding: m.embedding }, existingMemories);

    if (action.type === "skip") {
      continue;
    }

    const [inserted] = await db
      .insert(wmMemories)
      .values({
        accountId: account.id,
        endUserId: endUser.id,
        key: null,
        content: m.content,
        source: "extracted" as const,
        embedding: m.embedding,
        exchangeId: exchange.id,
        importance: 0.5,
      })
      .returning();

    if (action.type === "supersede") {
      await db
        .update(wmMemories)
        .set({ supersededBy: inserted.id })
        .where(eq(wmMemories.id, action.oldMemoryId));

      const idx = existingMemories.findIndex((e) => e.id === action.oldMemoryId);
      if (idx !== -1) existingMemories.splice(idx, 1);
    }

    existingMemories.push({
      id: inserted.id,
      content: m.content,
      embedding: m.embedding,
      source: "extracted" as const,
      key: null,
    });

    addedMemories.push({
      id: inserted.id,
      scope: externalId,
      key: null,
      value: inserted.content,
      source: "extracted",
      status: inserted.status as "ready" | "pending" | "failed",
      statusError: inserted.statusError,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
    });
  }

  await db
    .update(wmExchanges)
    .set({
      extractionStatus: "completed",
      extractionError: result.error,
      extractionCompletedAt: new Date(),
    })
    .where(eq(wmExchanges.id, exchange.id));

  return addedMemories;
}

/**
 * Structured error for extraction failures. Route handlers catch this
 * and return the standard error envelope.
 */
export class ExtractionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
    this.status = status;
  }
}
