import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import * as schema from "../../db/schema";
import {
  SCOPE_MAX_LENGTH,
  normalizeParams,
  setDeprecationHeader,
} from "../../lib/validation";
import { findEndUser } from "../../lib/end-users";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmMemories } = schema;

const RemoveRequestSchema = z.object({
  forScope: z.string().min(1).max(SCOPE_MAX_LENGTH),
  forKey: z.string().min(1).max(128),
});

export function removeRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/remove", async (c) => {
    const rawBody = await c.req.json();
    const { normalized, warnings } = normalizeParams(rawBody, ["userId", "key"]);
    setDeprecationHeader(c, warnings);

    const parsed = RemoveRequestSchema.safeParse(normalized);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid request body",
            details: parsed.error.issues,
          },
        },
        400
      );
    }

    const db = c.get("db");
    const account = c.get("account");
    const { forScope, forKey } = parsed.data;

    const endUser = await findEndUser(db, account.id, forScope);

    if (!endUser) {
      return c.json({ deleted: false });
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

    return c.json({ deleted: result.length > 0 });
  });

  return app;
}
