import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmEndUsers, wmMemories } = schema;

const ListMemoriesSchema = z.object({
  userId: z.string().min(1).max(255),
});

const listValidator = zValidator("json", ListMemoriesSchema, (result, c) => {
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

// UUID v4 regex for path param validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function memoriesRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // POST /v1/memories — list all memories for a user
  app.post("/memories", listValidator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId } = c.req.valid("json");

    const [endUser] = await db
      .select()
      .from(wmEndUsers)
      .where(and(eq(wmEndUsers.accountId, account.id), eq(wmEndUsers.externalId, userId)))
      .limit(1);

    if (!endUser) {
      return c.json({ memories: [] });
    }

    const rows = await db
      .select()
      .from(wmMemories)
      .where(and(eq(wmMemories.accountId, account.id), eq(wmMemories.endUserId, endUser.id)))
      .orderBy(desc(wmMemories.updatedAt));

    return c.json({
      memories: rows.map((m) => ({
        id: m.id,
        userId,
        key: m.key,
        value: m.content,
        source: m.source as "explicit" | "extracted",
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
    });
  });

  // DELETE /v1/memories/:id — delete a single memory by ID
  app.delete("/memories/:id", async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const memoryId = c.req.param("id");

    if (!UUID_RE.test(memoryId)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid memory ID format",
          },
        },
        400
      );
    }

    // Ownership check: always filter by account_id
    const result = await db
      .delete(wmMemories)
      .where(and(eq(wmMemories.id, memoryId), eq(wmMemories.accountId, account.id)))
      .returning({ id: wmMemories.id });

    return c.json({ deleted: result.length > 0 });
  });

  return app;
}
