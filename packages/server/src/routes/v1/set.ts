import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as schema from "../../db/schema";
import { SCOPE_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import type { WorkerEnv, AppVariables } from "../../types";
import { ensureEndUser } from "../../lib/end-users";
import { embedTexts } from "../../lib/embeddings";
import { checkMemoryQuota, PlanEnforcementError } from "../../lib/plan-enforcement";

const { wmMemories } = schema;

const SetRequestSchema = z.object({
  forScope: z.string().min(1).max(SCOPE_MAX_LENGTH),
  forKey: z.string().min(1).max(128),
  value: z.string().min(1).max(4096),
});

const validator = zValidator("json", SetRequestSchema, zodErrorHook);

export function setRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/set", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { forScope, forKey, value } = c.req.valid("json");

    // Quota check: reject before any DB write or embedding API call
    try {
      await checkMemoryQuota(db, account, 1);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    const endUser = await ensureEndUser(db, account.id, forScope);

    // Generate embedding for the value (best-effort, null on failure).
    let embedding: number[] | null = null;
    const apiKey = c.env.OPENAI_API_KEY;
    if (apiKey && value.length >= 20) {
      try {
        const results = await embedTexts(apiKey, [value]);
        embedding = results[0] ?? null;
      } catch (err) {
        console.warn(
          `set: embedding failed for forKey="${forKey}" (account=${account.id}): ${
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
        key: forKey,
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
        forScope: forScope,
        forKey: memory.key!,
        value: memory.content,
        source: memory.source,
        status: memory.status,
        statusError: memory.statusError,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
      },
    });
  });

  return app;
}
