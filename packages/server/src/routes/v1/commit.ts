import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { ensureEndUser } from "../../lib/end-users";
import { USER_ID_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import { runExtraction, parseMaxInputBytes } from "../../lib/extraction";
import { classifyFact, type ExistingMemory } from "../../lib/dedup";
import EXTRACTION_PROMPT from "../../lib/extraction-prompt.txt";
import { checkMemoryQuota, PlanEnforcementError } from "../../lib/plan-enforcement";

const { wmExchanges, wmMemories } = schema;

const CommitRequestSchema = z.object({
  userId: z.string().min(1).max(USER_ID_MAX_LENGTH),
  input: z.string().min(1),
  output: z.string().min(1),
});

const validator = zValidator("json", CommitRequestSchema, zodErrorHook);

export function commitRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/commit", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId, input, output } = c.req.valid("json");

    // Enforce size cap
    const maxBytes = parseMaxInputBytes(c.env.EXTRACTION_MAX_INPUT_BYTES);
    const encoder = new TextEncoder();
    const actualBytes = encoder.encode(input).byteLength + encoder.encode(output).byteLength;
    if (actualBytes > maxBytes) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Commit exceeds maximum size",
            details: { maxBytes, actualBytes },
          },
        },
        400
      );
    }

    // Quota check: reject before any DB write or LLM call.
    // commit() accepts a single exchange, not a batch — extraction may produce
    // 0-N memories, but we don't know the count until after the LLM runs.
    // Pre-check with 1: "can the account accept at least one more memory?"
    // If not, reject the entire commit. Individual inserts inside waitUntil
    // could still exceed quota mid-extraction (same race condition documented
    // in plan-enforcement.ts).
    try {
      await checkMemoryQuota(db, account, 1);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    // Idempotency check
    const idempotencyKey = c.req.header("Idempotency-Key")?.slice(0, 255) || null;
    if (idempotencyKey) {
      const [existing] = await db
        .select({ id: wmExchanges.id })
        .from(wmExchanges)
        .where(
          and(
            eq(wmExchanges.accountId, account.id),
            eq(wmExchanges.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        return c.json({}, 202);
      }
    }

    const endUser = await ensureEndUser(db, account.id, userId);

    // Resolve extraction prompt: custom per-account prompt wins over the bundled default
    const extractionPrompt = account.extractionPrompt ?? EXTRACTION_PROMPT;
    const promptVersion = account.extractionPrompt
      ? "custom"
      : c.env.EXTRACTION_PROMPT_VERSION || null;

    // Insert exchange row
    const [exchange] = await db
      .insert(wmExchanges)
      .values({
        accountId: account.id,
        endUserId: endUser.id,
        input,
        output,
        idempotencyKey,
        promptVersion,
        extractionStatus: "pending",
      })
      .returning();

    // Return 202 immediately, run extraction in the background
    const response = c.json({}, 202);

    c.executionCtx.waitUntil(
      (async () => {
        try {
          const apiKey = c.env.OPENAI_API_KEY;

          if (!apiKey) {
            await db
              .update(wmExchanges)
              .set({
                extractionStatus: "failed",
                extractionError: "Missing OPENAI_API_KEY",
                extractionCompletedAt: new Date(),
              })
              .where(eq(wmExchanges.id, exchange.id));
            return;
          }

          const result = await runExtraction({
            openaiApiKey: apiKey,
            prompt: extractionPrompt,
            promptVersion: promptVersion || "unknown",
            input: { input, output },
          });

          if (result.error && result.memories.length === 0) {
            // Extraction failed entirely
            await db
              .update(wmExchanges)
              .set({
                extractionStatus: "failed",
                extractionError: result.error,
                extractionCompletedAt: new Date(),
              })
              .where(eq(wmExchanges.id, exchange.id));
            console.error(
              `Extraction failed for exchange ${exchange.id}: ${result.error}`
            );
            return;
          }

          if (result.memories.length === 0) {
            // Empty extraction — the expected case ~70% of the time
            await db
              .update(wmExchanges)
              .set({
                extractionStatus: "skipped",
                extractionCompletedAt: new Date(),
              })
              .where(eq(wmExchanges.id, exchange.id));
            return;
          }

          // ── Dedup: fetch existing memories for this user ──────────
          // Fetches ALL non-superseded memories, including those without
          // embeddings. Null-embedding rows are skipped during similarity
          // comparison but are still visible to the dedup logic so they
          // aren't silently excluded.
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

          // Only memories with embeddings can participate in similarity
          // comparison. Null-embedding memories are invisible to dedup.
          const existingMemories: ExistingMemory[] = existingRows
            .filter((r) => r.embedding !== null)
            .map((r) => ({
              id: r.id,
              content: r.content,
              embedding: r.embedding as number[],
              source: r.source,
              key: r.key,
            }));

          // ── Classify and execute each extracted fact ────────────
          for (const m of result.memories) {
            if (!m.embedding) {
              // No embedding — insert without dedup (rare fallback path)
              await db.insert(wmMemories).values({
                accountId: account.id,
                endUserId: endUser.id,
                key: null,
                content: m.content,
                source: "extracted" as const,
                embedding: null,
                exchangeId: exchange.id,
                importance: 0.5,
              });
              continue;
            }

            const action = classifyFact(
              { content: m.content, embedding: m.embedding },
              existingMemories
            );

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
              .returning({ id: wmMemories.id });

            if (action.type === "supersede") {
              // DB update first, then in-memory splice — if the update
              // fails and throws, existingMemories stays consistent.
              await db
                .update(wmMemories)
                .set({ supersededBy: inserted.id })
                .where(eq(wmMemories.id, action.oldMemoryId));

              const idx = existingMemories.findIndex((e) => e.id === action.oldMemoryId);
              if (idx !== -1) existingMemories.splice(idx, 1);
            }

            // Keep existingMemories in sync so subsequent iterations
            // see this fact during dedup classification.
            existingMemories.push({
              id: inserted.id,
              content: m.content,
              embedding: m.embedding,
              source: "extracted" as const,
              key: null,
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
        } catch (err) {
          console.error(
            `Extraction crashed for exchange ${exchange.id}:`,
            err instanceof Error ? err.message : err
          );
          try {
            await db
              .update(wmExchanges)
              .set({
                extractionStatus: "failed",
                extractionError:
                  err instanceof Error ? err.message : "unknown error",
                extractionCompletedAt: new Date(),
              })
              .where(eq(wmExchanges.id, exchange.id));
          } catch {
            // Last resort — the exchange row is the audit trail, logs are backup
          }
        }
      })()
    );

    return response;
  });

  return app;
}
