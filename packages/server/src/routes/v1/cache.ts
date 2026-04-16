import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, sql, gt } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { zodErrorHook } from "../../lib/validation";
import { sha256Hex } from "../../lib/hash";
import { getClientIp } from "../../lib/ip";
import { cacheAuthMiddleware } from "../../middleware/cache-auth";
import { authMiddleware } from "../../middleware/auth";
import { createDb } from "../../db/client";
import { ensureEndUser } from "../../lib/end-users";

const { wmCaches, wmCacheEntries, wmAccounts, wmMemories } = schema;

// ─── Zod schemas ──────────────────────────────────────────────────────────

const CreateCacheSchema = z
  .object({
    ttlSeconds: z.number().int().min(60).max(86400).optional().default(86400),
  })
  .strict();

const CacheSetSchema = z
  .object({
    key: z.string().min(1).max(255),
    value: z.string().min(1).max(10240),
  })
  .strict();

const CacheKeySchema = z
  .object({
    key: z.string().min(1).max(255),
  })
  .strict();

const ClaimSchema = z
  .object({
    claimToken: z.string().min(1),
  })
  .strict();

// ─── Route factory ──────────────────────────────────────────────────────────

export function cacheRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // ─── POST /cache — create a new cache (no auth) ────────────────────────
  app.post("/cache", zValidator("json", CreateCacheSchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const { ttlSeconds } = c.req.valid("json");
    const ip = getClientIp(c);

    // Rate limit: 3 caches per IP per 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmCaches)
      .where(and(eq(wmCaches.ipAddress, ip), gt(wmCaches.createdAt, twentyFourHoursAgo)));

    if ((countRow?.count ?? 0) >= 3) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: "Cache creation rate limit exceeded (3 per 24 hours)",
            request_id: c.get("requestId"),
          },
        },
        429
      );
    }

    // Generate tokens
    const rawTokenBytes = new Uint8Array(32);
    crypto.getRandomValues(rawTokenBytes);
    const rawTokenRandom = btoa(String.fromCharCode(...rawTokenBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const rawToken = `wm_tmp_${rawTokenRandom}`;

    const claimTokenBytes = new Uint8Array(32);
    crypto.getRandomValues(claimTokenBytes);
    const claimTokenRandom = btoa(String.fromCharCode(...claimTokenBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const claimToken = `wm_claim_${claimTokenRandom}`;

    const tokenHash = await sha256Hex(rawToken);
    const claimTokenHash = await sha256Hex(claimToken);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const [cache] = await db
      .insert(wmCaches)
      .values({
        tokenHash,
        ipAddress: ip,
        ttlSeconds,
        expiresAt,
        claimTokenHash,
      })
      .returning();

    return c.json(
      {
        cache: {
          id: cache.id,
          rawToken,
          claimToken,
          claimUrl: `https://app.withmemory.dev/claim/${claimToken}`,
          expiresAt: cache.expiresAt.toISOString(),
        },
        request_id: c.get("requestId"),
      },
      201
    );
  });

  // ─── POST /cache/preview — preview cache contents (claim token auth) ──
  app.post("/cache/preview", zValidator("json", ClaimSchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const { claimToken } = c.req.valid("json");

    const claimTokenHash = await sha256Hex(claimToken);
    const [cache] = await db
      .select()
      .from(wmCaches)
      .where(eq(wmCaches.claimTokenHash, claimTokenHash))
      .limit(1);

    if (!cache) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: "Cache not found",
            request_id: c.get("requestId"),
          },
        },
        404
      );
    }

    if (cache.claimedAt !== null) {
      return c.json(
        {
          error: {
            code: "already_claimed",
            message: "Cache has already been claimed",
            request_id: c.get("requestId"),
          },
        },
        409
      );
    }

    if (cache.expiresAt.getTime() < Date.now()) {
      return c.json(
        {
          error: {
            code: "cache_expired",
            message: "Cache has expired",
            request_id: c.get("requestId"),
          },
        },
        410
      );
    }

    const entries = await db
      .select({ key: wmCacheEntries.key })
      .from(wmCacheEntries)
      .where(eq(wmCacheEntries.cacheId, cache.id))
      .orderBy(wmCacheEntries.key);

    return c.json({
      cache: {
        id: cache.id,
        entryCount: entries.length,
        expiresAt: cache.expiresAt.toISOString(),
        entries: entries.map((e) => ({ key: e.key })),
      },
      request_id: c.get("requestId"),
    });
  });

  // ─── Cache-auth middleware for CRUD endpoints ──────────────────────────
  // Applied to set, get, delete, list below via app.use()
  app.use("/cache/set", async (c, next) => {
    const db = c.get("db");
    return cacheAuthMiddleware(db)(c, next);
  });
  app.use("/cache/get", async (c, next) => {
    const db = c.get("db");
    return cacheAuthMiddleware(db)(c, next);
  });
  app.use("/cache/delete", async (c, next) => {
    const db = c.get("db");
    return cacheAuthMiddleware(db)(c, next);
  });
  app.use("/cache/list", async (c, next) => {
    const db = c.get("db");
    return cacheAuthMiddleware(db)(c, next);
  });

  // ─── POST /cache/set (cache auth) ─────────────────────────────────────
  app.post("/cache/set", zValidator("json", CacheSetSchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const cache = c.get("cache");
    const { key, value } = c.req.valid("json");

    // Entry count limit
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmCacheEntries)
      .where(eq(wmCacheEntries.cacheId, cache.id));

    if ((countRow?.count ?? 0) >= 50) {
      // Check if this key already exists (update won't increase count)
      const [existing] = await db
        .select({ id: wmCacheEntries.id })
        .from(wmCacheEntries)
        .where(and(eq(wmCacheEntries.cacheId, cache.id), eq(wmCacheEntries.key, key)))
        .limit(1);

      if (!existing) {
        return c.json(
          {
            error: {
              code: "cache_entry_limit",
              message: "Cache entry limit reached (50 max)",
              request_id: c.get("requestId"),
            },
          },
          403
        );
      }
    }

    const [entry] = await db
      .insert(wmCacheEntries)
      .values({ cacheId: cache.id, key, value })
      .onConflictDoUpdate({
        target: [wmCacheEntries.cacheId, wmCacheEntries.key],
        set: { value, updatedAt: new Date() },
      })
      .returning();

    return c.json({
      entry: {
        key: entry.key,
        value: entry.value,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      },
      request_id: c.get("requestId"),
    });
  });

  // ─── POST /cache/get (cache auth) ─────────────────────────────────────
  app.post("/cache/get", zValidator("json", CacheKeySchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const cache = c.get("cache");
    const { key } = c.req.valid("json");

    const [entry] = await db
      .select()
      .from(wmCacheEntries)
      .where(and(eq(wmCacheEntries.cacheId, cache.id), eq(wmCacheEntries.key, key)))
      .limit(1);

    if (!entry) {
      return c.json({ entry: null, request_id: c.get("requestId") });
    }

    return c.json({
      entry: {
        key: entry.key,
        value: entry.value,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      },
      request_id: c.get("requestId"),
    });
  });

  // ─── POST /cache/delete (cache auth) ──────────────────────────────────
  app.post("/cache/delete", zValidator("json", CacheKeySchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const cache = c.get("cache");
    const { key } = c.req.valid("json");

    const result = await db
      .delete(wmCacheEntries)
      .where(and(eq(wmCacheEntries.cacheId, cache.id), eq(wmCacheEntries.key, key)))
      .returning({ id: wmCacheEntries.id });

    return c.json({
      result: { deleted: result.length > 0 },
      request_id: c.get("requestId"),
    });
  });

  // ─── GET /cache/list (cache auth) ─────────────────────────────────────
  app.get("/cache/list", async (c) => {
    const db = c.get("db");
    const cache = c.get("cache");

    const entries = await db
      .select({
        key: wmCacheEntries.key,
        createdAt: wmCacheEntries.createdAt,
        updatedAt: wmCacheEntries.updatedAt,
      })
      .from(wmCacheEntries)
      .where(eq(wmCacheEntries.cacheId, cache.id))
      .orderBy(wmCacheEntries.key);

    return c.json({
      entries: entries.map((e) => ({
        key: e.key,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      })),
      request_id: c.get("requestId"),
    });
  });

  // ─── POST /cache/claim (regular API key auth) ─────────────────────────
  app.use("/cache/claim", async (c, next) => {
    const db = c.get("db");
    return authMiddleware(db)(c, next);
  });

  app.post("/cache/claim", zValidator("json", ClaimSchema, zodErrorHook), async (c) => {
    const db = c.get("db");
    const account = c.get("account");
    const { claimToken } = c.req.valid("json");

    const claimTokenHash = await sha256Hex(claimToken);
    const [cache] = await db
      .select()
      .from(wmCaches)
      .where(eq(wmCaches.claimTokenHash, claimTokenHash))
      .limit(1);

    if (!cache) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: "Cache not found",
            request_id: c.get("requestId"),
          },
        },
        404
      );
    }

    if (cache.claimedAt !== null) {
      return c.json(
        {
          error: {
            code: "already_claimed",
            message: "Cache has already been claimed",
            request_id: c.get("requestId"),
          },
        },
        409
      );
    }

    if (cache.expiresAt.getTime() < Date.now()) {
      return c.json(
        {
          error: {
            code: "cache_expired",
            message: "Cache has expired",
            request_id: c.get("requestId"),
          },
        },
        410
      );
    }

    // Fetch all cache entries
    const entries = await db
      .select()
      .from(wmCacheEntries)
      .where(eq(wmCacheEntries.cacheId, cache.id));

    // Create a container for the claimed memories
    const subEmailSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const subEmail = `cache_${subEmailSuffix}@sub.withmemory.internal`;
    const shortId = cache.id.slice(0, 8);

    const [container] = await db
      .insert(wmAccounts)
      .values({
        email: subEmail,
        name: `Claimed cache ${shortId}`,
        metadata: {},
        parentAccountId: account.id,
        planTier: account.planTier,
        memoryLimit: account.memoryLimit,
      })
      .returning();

    // Create end user and memories for each entry
    const endUser = await ensureEndUser(db, container.id, `cache-${cache.id}`);

    for (const entry of entries) {
      await db.insert(wmMemories).values({
        accountId: container.id,
        endUserId: endUser.id,
        key: entry.key,
        content: entry.value,
        source: "explicit",
      });
    }

    // Mark cache as claimed
    await db
      .update(wmCaches)
      .set({
        claimedByAccountId: account.id,
        claimedAt: new Date(),
      })
      .where(eq(wmCaches.id, cache.id));

    return c.json({
      result: {
        claimed: true,
        containerId: container.id,
        memoriesCreated: entries.length,
      },
      request_id: c.get("requestId"),
    });
  });

  return app;
}
