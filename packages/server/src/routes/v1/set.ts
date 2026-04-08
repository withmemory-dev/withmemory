import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { AppVariables } from "../../types";

const { wmEndUsers, wmMemories } = schema;

type Env = { DATABASE_URL: string };

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
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.post("/set", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId, key, value } = c.req.valid("json");

    // Upsert end user: insert if missing, no-op on conflict
    await db
      .insert(wmEndUsers)
      .values({ accountId: account.id, externalId: userId })
      .onConflictDoNothing({ target: [wmEndUsers.accountId, wmEndUsers.externalId] });

    const [endUser] = await db
      .select()
      .from(wmEndUsers)
      .where(and(eq(wmEndUsers.accountId, account.id), eq(wmEndUsers.externalId, userId)))
      .limit(1);

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
