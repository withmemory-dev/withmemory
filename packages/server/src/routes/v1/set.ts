import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { ensureEndUser } from "../../lib/end-users";
import { embedTexts } from "../../lib/embeddings";

const { wmMemories } = schema;

const SetRequestSchema = z.object({
  userId: z.string().min(1).max(256),
  key: z.string().min(1).max(128),
  value: z.string().min(1).max(4096),
});

const validator = zValidator("json", SetRequestSchema, (result, c) => {
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

export function setRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/set", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId, key, value } = c.req.valid("json");

    const endUser = await ensureEndUser(db, account.id, userId);

    // Generate embedding for the value (best-effort, null on failure).
    // Terse values (< 30 chars, e.g. "Andrew", "pro") embed poorly and
    // would be unfairly killed by the similarity floor. They store
    // embedding: null and get the 0.5 fallback score via the existing
    // null-embedding path, which bypasses the floor.
    let embedding: number[] | null = null;
    const apiKey = c.env.OPENAI_API_KEY;
    if (apiKey && value.length >= 20) {
      try {
        const results = await embedTexts(apiKey, [value]);
        embedding = results[0] ?? null;
      } catch (err) {
        console.warn(
          `set: embedding failed for key="${key}" (account=${account.id}): ${
            err instanceof Error ? err.message : "unknown error"
          }`
        );
      }
    }

    // Upsert memory: insert or update on (account, end_user, key) conflict
    const [memory] = await db
      .insert(wmMemories)
      .values({
        accountId: account.id,
        endUserId: endUser.id,
        key,
        content: value,
        source: "explicit",
        embedding,
      })
      .onConflictDoUpdate({
        target: [wmMemories.accountId, wmMemories.endUserId, wmMemories.key],
        set: {
          content: value,
          embedding,
          updatedAt: new Date(),
        },
      })
      .returning();

    return c.json({
      memory: {
        id: memory.id,
        userId: userId,
        key: memory.key!,
        value: memory.content,
        source: memory.source,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
      },
    });
  });

  return app;
}
