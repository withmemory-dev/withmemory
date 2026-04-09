import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { ensureEndUser } from "../../lib/end-users";

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

    // Upsert memory: insert or update on (account, end_user, key) conflict
    const [memory] = await db
      .insert(wmMemories)
      .values({
        accountId: account.id,
        endUserId: endUser.id,
        key,
        content: value,
        source: "explicit",
      })
      .onConflictDoUpdate({
        target: [wmMemories.accountId, wmMemories.endUserId, wmMemories.key],
        set: {
          content: value,
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
