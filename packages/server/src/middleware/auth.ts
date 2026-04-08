import type { Context, Next } from "hono";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";

const { wmApiKeys, wmAccounts } = schema;
import { sha256Hex } from "../lib/hash";

type Db = PostgresJsDatabase<typeof schema>;

export function authMiddleware(db: Db) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing Authorization header" } },
        401
      );
    }

    const rawKey = authHeader.slice(7);

    if (!authHeader.startsWith("Bearer ") || rawKey.length === 0) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Malformed Authorization header. Expected format: Bearer <key>",
          },
        },
        401
      );
    }
    const hashedKey = await sha256Hex(rawKey);

    const result = await db
      .select({
        apiKey: wmApiKeys,
        account: wmAccounts,
      })
      .from(wmApiKeys)
      .innerJoin(wmAccounts, eq(wmApiKeys.accountId, wmAccounts.id))
      .where(eq(wmApiKeys.keyHash, hashedKey))
      .limit(1);

    if (result.length === 0) {
      return c.json(
        { error: { code: "unauthorized", message: "Invalid API key" } },
        401
      );
    }

    const { apiKey, account } = result[0];
    c.set("account", account);
    c.set("apiKey", apiKey);

    // Fire-and-forget last_used_at update — the race between concurrent
    // requests doesn't matter for this field, so no throttling needed.
    // waitUntil keeps the Worker alive until the write completes without
    // blocking the response.
    c.executionCtx.waitUntil(
      db
        .update(wmApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(wmApiKeys.id, apiKey.id))
        .then(() => {})
        .catch(() => {})
    );

    await next();
  };
}
