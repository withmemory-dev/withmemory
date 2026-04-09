import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, desc } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";

const { wmEndUsers, wmMemories } = schema;

const RecallRequestSchema = z.object({
  userId: z.string().min(1).max(256),
  input: z.string().min(1).max(8192),
  maxItems: z.number().int().min(1).max(50).optional(),
  maxTokens: z.number().int().min(10).max(2000).optional(),
});

const validator = zValidator("json", RecallRequestSchema, (result, c) => {
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

export function recallRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/recall", validator, async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { userId, maxItems, maxTokens } = c.req.valid("json");

    // Look up end user — if they don't exist, they have no memories
    const [endUser] = await db
      .select()
      .from(wmEndUsers)
      .where(and(eq(wmEndUsers.accountId, account.id), eq(wmEndUsers.externalId, userId)))
      .limit(1);

    if (!endUser) {
      return c.json({ promptBlock: "", memories: [] });
    }

    const resolvedMaxItems = maxItems ?? 4;

    // Naive ranking: most recently updated first
    const rows = await db
      .select()
      .from(wmMemories)
      .where(and(eq(wmMemories.accountId, account.id), eq(wmMemories.endUserId, endUser.id)))
      .orderBy(desc(wmMemories.updatedAt))
      .limit(resolvedMaxItems);

    // Format prompt block and trim to fit token budget
    const resolvedMaxTokens = maxTokens ?? 150;
    const maxChars = resolvedMaxTokens * 4;

    const formatted = rows.map((m) => (m.key ? `${m.key}: ${m.content}` : m.content));

    let kept = [...formatted];
    let keptRows = [...rows];
    while (kept.join("\n").length > maxChars && kept.length > 0) {
      kept.pop();
      keptRows.pop();
    }

    const promptBlock = kept.join("\n");

    return c.json({
      promptBlock,
      memories: keptRows.map((m) => ({
        id: m.id,
        userId: userId,
        key: m.key,
        value: m.content,
        source: m.source as "explicit" | "extracted",
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
    });
  });

  return app;
}
