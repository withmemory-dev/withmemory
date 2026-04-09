import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { ensureEndUser } from "../../lib/end-users";
import { runExtraction, parseMaxInputBytes } from "../../lib/extraction";

const { wmExchanges, wmMemories } = schema;

const CommitRequestSchema = z.object({
  userId: z.string().min(1).max(255),
  input: z.string().min(1),
  output: z.string().min(1),
});

const validator = zValidator("json", CommitRequestSchema, (result, c) => {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: "invalid_request",
          message: "Invalid request body",
          details: result.error.issues,
        },
      },
      400
    );
  }
});

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

    // Insert exchange row
    const [exchange] = await db
      .insert(wmExchanges)
      .values({
        accountId: account.id,
        endUserId: endUser.id,
        input,
        output,
        idempotencyKey,
        promptVersion: c.env.EXTRACTION_PROMPT_VERSION || null,
        extractionStatus: "pending",
      })
      .returning();

    // Return 202 immediately, run extraction in the background
    const response = c.json({}, 202);

    c.executionCtx.waitUntil(
      (async () => {
        try {
          const prompt = c.env.EXTRACTION_PROMPT;
          const apiKey = c.env.OPENAI_API_KEY;

          if (!prompt || !apiKey) {
            await db
              .update(wmExchanges)
              .set({
                extractionStatus: "failed",
                extractionError: "Missing OPENAI_API_KEY or EXTRACTION_PROMPT",
                extractionCompletedAt: new Date(),
              })
              .where(eq(wmExchanges.id, exchange.id));
            return;
          }

          const result = await runExtraction({
            openaiApiKey: apiKey,
            prompt,
            promptVersion: c.env.EXTRACTION_PROMPT_VERSION || "unknown",
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

          // Insert extracted memories
          await db.insert(wmMemories).values(
            result.memories.map((m) => ({
              accountId: account.id,
              endUserId: endUser.id,
              key: null,
              content: m.content,
              source: "extracted" as const,
              embedding: m.embedding,
              exchangeId: exchange.id,
              importance: 0.5,
            }))
          );

          await db
            .update(wmExchanges)
            .set({
              extractionStatus: result.error ? "completed" : "completed",
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
