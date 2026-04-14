import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema";
import { SCOPE_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import { findEndUser } from "../../lib/end-users";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmMemories } = schema;

const RemoveRequestSchema = z.object({
  forScope: z.string().min(1).max(SCOPE_MAX_LENGTH),
  forKey: z.string().min(1).max(128),
});

const validator = zValidator("json", RemoveRequestSchema, zodErrorHook);

export function removeRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/memories/remove", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { forScope, forKey } = c.req.valid("json");

    const endUser = await findEndUser(db, account.id, forScope);

    if (!endUser) {
      return c.json({ deleted: false, request_id: c.get("requestId") });
    }

    const result = await db
      .delete(wmMemories)
      .where(
        and(
          eq(wmMemories.accountId, account.id),
          eq(wmMemories.endUserId, endUser.id),
          eq(wmMemories.key, forKey)
        )
      )
      .returning({ id: wmMemories.id });

    return c.json({ deleted: result.length > 0, request_id: c.get("requestId") });
  });

  return app;
}
