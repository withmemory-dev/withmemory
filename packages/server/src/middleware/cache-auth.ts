import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { wmCaches } from "../db/schema";
import { sha256Hex } from "../lib/hash";
import type { Database } from "../db/client";

/**
 * Cache auth middleware — authenticates requests using a cache token.
 *
 * Completely separate from the API key auth path. Reads a Bearer token,
 * hashes it, and looks it up in wm_caches.token_hash. Rejects expired
 * or claimed caches.
 */
export function cacheAuthMiddleware(db: Database) {
  return async (c: Context, next: Next) => {
    const requestId = c.get("requestId");
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.length <= 7) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Missing or malformed Authorization header",
            request_id: requestId,
          },
        },
        401
      );
    }

    const rawToken = authHeader.slice(7);
    const tokenHash = await sha256Hex(rawToken);

    const [cache] = await db
      .select()
      .from(wmCaches)
      .where(eq(wmCaches.tokenHash, tokenHash))
      .limit(1);

    if (!cache) {
      return c.json(
        { error: { code: "unauthorized", message: "Invalid cache token", request_id: requestId } },
        401
      );
    }

    if (cache.expiresAt.getTime() < Date.now()) {
      return c.json(
        { error: { code: "unauthorized", message: "Cache expired", request_id: requestId } },
        401
      );
    }

    if (cache.claimedAt !== null) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Cache has been claimed",
            request_id: requestId,
          },
        },
        401
      );
    }

    c.set("cache", cache);
    await next();
  };
}
