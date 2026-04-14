import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "../../db/schema";
import { SCOPE_MAX_LENGTH, zodErrorHook } from "../../lib/validation";
import { findEndUser } from "../../lib/end-users";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmMemories } = schema;

const GetRequestSchema = z.object({
  forScope: z.string().min(1).max(SCOPE_MAX_LENGTH),
  forKey: z.string().min(1).max(128),
});

const validator = zValidator("json", GetRequestSchema, zodErrorHook);

export function getRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/memories/get", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { forScope, forKey } = c.req.valid("json");

    const endUser = await findEndUser(db, account.id, forScope);

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
          eq(wmMemories.key, forKey),
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
        forScope,
        forKey: memory.key,
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
