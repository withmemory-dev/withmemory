import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "../../db/schema";
import { USER_ID_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmEndUsers, wmMemories } = schema;

const GetRequestSchema = z.object({
  userId: z.string().min(1).max(USER_ID_MAX_LENGTH),
  key: z.string().min(1).max(128),
});

const validator = zValidator("json", GetRequestSchema, zodErrorHook);

export function getRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/get", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId, key } = c.req.valid("json");

    const [endUser] = await db
      .select()
      .from(wmEndUsers)
      .where(and(eq(wmEndUsers.accountId, account.id), eq(wmEndUsers.externalId, userId)))
      .limit(1);

    if (!endUser) {
      return c.json({ memory: null });
    }

    const [memory] = await db
      .select()
      .from(wmMemories)
      .where(
        and(
          eq(wmMemories.accountId, account.id),
          eq(wmMemories.endUserId, endUser.id),
          eq(wmMemories.key, key),
          isNull(wmMemories.supersededBy)
        )
      )
      .limit(1);

    if (!memory) {
      return c.json({ memory: null });
    }

    return c.json({
      memory: {
        id: memory.id,
        userId,
        key: memory.key,
        value: memory.content,
        source: memory.source,
        createdAt: memory.createdAt.toISOString(),
        updatedAt: memory.updatedAt.toISOString(),
      },
    });
  });

  return app;
}
