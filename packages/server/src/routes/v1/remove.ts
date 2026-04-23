import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema";
import { SCOPE_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import { findEndUser } from "../../lib/end-users";
import { requireScopes } from "../../lib/scopes";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmMemories } = schema;

const RemoveRequestSchema = z
  .object({
    scope: z.string().min(1).max(SCOPE_MAX_LENGTH),
    key: z.string().min(1).max(128),
  })
  .strict();

const validator = zValidator("json", RemoveRequestSchema, zodErrorHook);

export function removeRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/memories/remove", validator, async (c) => {
    const scopeError = requireScopes(c, "memory:write");
    if (scopeError) return c.json(scopeError, 403);

    const db = c.get("db");
    const account = c.get("account");
    const { scope, key } = c.req.valid("json");

    const endUser = await findEndUser(db, account.id, scope);

    if (!endUser) {
      return c.json({ result: { deleted: false }, request_id: c.get("requestId") });
    }

    const deleted = await db
      .delete(wmMemories)
      .where(
        and(
          eq(wmMemories.accountId, account.id),
          eq(wmMemories.endUserId, endUser.id),
          eq(wmMemories.key, key)
        )
      )
      .returning({ id: wmMemories.id });

    return c.json({ result: { deleted: deleted.length > 0 }, request_id: c.get("requestId") });
  });

  return app;
}
