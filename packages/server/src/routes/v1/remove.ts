import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema";
import { USER_ID_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmEndUsers, wmMemories } = schema;

const RemoveRequestSchema = z.object({
  userId: z.string().min(1).max(USER_ID_MAX_LENGTH),
  key: z.string().min(1).max(128),
});

const validator = zValidator("json", RemoveRequestSchema, zodErrorHook);

export function removeRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/remove", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId, key } = c.req.valid("json");

    const [endUser] = await db
      .select()
      .from(wmEndUsers)
      .where(and(eq(wmEndUsers.accountId, account.id), eq(wmEndUsers.externalId, userId)))
      .limit(1);

    if (!endUser) {
      return c.json({ deleted: false });
    }

    const result = await db
      .delete(wmMemories)
      .where(
        and(
          eq(wmMemories.accountId, account.id),
          eq(wmMemories.endUserId, endUser.id),
          eq(wmMemories.key, key)
        )
      )
      .returning({ id: wmMemories.id });

    return c.json({ deleted: result.length > 0 });
  });

  return app;
}
