import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { zodErrorHook } from "../../lib/validation";
import { requirePlan, PlanEnforcementError } from "../../lib/plan-enforcement";
import { sha256Hex } from "../../lib/hash";

const { wmAccounts, wmApiKeys, wmMemories } = schema;

// ─── Container limits per plan tier ──────────────────────────────────────
const CONTAINER_LIMITS: Record<string, number> = {
  pro: 10,
  team: 100,
  enterprise: Infinity,
};

// ─── Shared guard: require top-level account with account:admin scope ──────
function requireAdminScope(c: {
  get(key: "account"): schema.WmAccount;
  get(key: "apiKey"): schema.WmApiKey;
}) {
  const account = c.get("account");
  const apiKey = c.get("apiKey");

  // Containers cannot call container management endpoints
  if (account.parentAccountId !== null) {
    return {
      error: {
        code: "unauthorized",
        message: "Containers cannot manage other containers",
      } as const,
    };
  }

  // Require account:admin scope
  if (!apiKey.scopes.includes("account:admin")) {
    return {
      error: {
        code: "unauthorized",
        message: "API key lacks account:admin scope",
      } as const,
    };
  }

  return null;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────
const CreateContainerSchema = z.object({
  name: z.string().min(1).max(255),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CreateKeySchema = z.object({
  issuedTo: z.string().min(1).max(255),
  scopes: z.string().optional(),
  expiresIn: z.number().int().min(1).max(31536000).optional(),
});

const DeleteContainerSchema = z.object({
  confirm: z.literal(true),
});

// ─── Route factory ──────────────────────────────────────────────────────────

export function containersRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // ─── POST /containers — create a container ──────────────────────────
  app.post("/containers", zValidator("json", CreateContainerSchema, zodErrorHook), async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");
    const { name, metadata } = c.req.valid("json");

    try {
      requirePlan(account, ["pro", "team", "enterprise"]);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    // Check container limit
    const limit = CONTAINER_LIMITS[account.planTier] ?? 0;
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmAccounts)
      .where(eq(wmAccounts.parentAccountId, account.id));
    const current = countRow?.count ?? 0;

    if (current >= limit) {
      return c.json(
        {
          error: {
            code: "container_limit_exceeded",
            message: `Container limit reached (${current} / ${limit}). Upgrade to increase your limit.`,
            details: { current, limit, plan_tier: account.planTier },
          },
        },
        403
      );
    }

    // Containers use a generated email to satisfy the NOT NULL unique constraint.
    const subEmailSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const subEmail = `sub_${subEmailSuffix}@sub.withmemory.internal`;

    const [container] = await db
      .insert(wmAccounts)
      .values({
        email: subEmail,
        name,
        metadata: metadata ?? {},
        parentAccountId: account.id,
        planTier: account.planTier,
        memoryLimit: account.memoryLimit,
      })
      .returning();

    return c.json(
      {
        account: {
          id: container.id,
          parentAccountId: container.parentAccountId,
          name: container.name,
          metadata: container.metadata ?? {},
          planTier: container.planTier,
          memoryLimit: container.memoryLimit,
          createdAt: container.createdAt.toISOString(),
        },
      },
      201
    );
  });

  // ─── POST /containers/:id/keys — mint a container key ───────────────
  app.post("/containers/:id/keys", zValidator("json", CreateKeySchema, zodErrorHook), async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");
    const apiKey = c.get("apiKey");
    const containerId = c.req.param("id");
    const { issuedTo, scopes, expiresIn } = c.req.valid("json");

    try {
      requirePlan(account, ["pro", "team", "enterprise"]);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    // Validate scopes: account:admin is not allowed on container keys
    const resolvedScopes = scopes ?? "memory:read,memory:write";
    if (resolvedScopes.includes("account:admin")) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "Container keys cannot have account:admin scope",
          },
        },
        400
      );
    }

    // Verify container exists and belongs to this parent
    const [container] = await db
      .select()
      .from(wmAccounts)
      .where(and(eq(wmAccounts.id, containerId), eq(wmAccounts.parentAccountId, account.id)))
      .limit(1);

    if (!container) {
      return c.json({ error: { code: "not_found", message: "Container not found" } }, 404);
    }

    // Generate raw key: wm_live_ + base64url(32 random bytes)
    const randomBuf = new Uint8Array(32);
    crypto.getRandomValues(randomBuf);
    const rawRandom = btoa(String.fromCharCode(...randomBuf))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const rawKey = `wm_live_${rawRandom}`;
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = await sha256Hex(rawKey);

    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    const [newKey] = await db
      .insert(wmApiKeys)
      .values({
        accountId: containerId,
        keyHash,
        keyPrefix,
        scopes: resolvedScopes,
        issuedTo,
        expiresAt,
        parentKeyId: apiKey.id,
      })
      .returning();

    return c.json(
      {
        key: {
          id: newKey.id,
          accountId: newKey.accountId,
          keyPrefix: newKey.keyPrefix,
          scopes: newKey.scopes,
          issuedTo: newKey.issuedTo,
          expiresAt: newKey.expiresAt?.toISOString() ?? null,
          createdAt: newKey.createdAt.toISOString(),
        },
        rawKey,
      },
      201
    );
  });

  // ─── GET /containers — list containers ────────────────────────────────
  app.get("/containers", async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");

    try {
      requirePlan(account, ["pro", "team", "enterprise"]);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    const containers = await db
      .select({
        id: wmAccounts.id,
        parentAccountId: wmAccounts.parentAccountId,
        name: wmAccounts.name,
        metadata: wmAccounts.metadata,
        createdAt: wmAccounts.createdAt,
        memoryCount: sql<number>`(
          SELECT count(*)::int FROM wm_memories
          WHERE wm_memories.account_id = wm_accounts.id
            AND wm_memories.superseded_by IS NULL
        )`,
      })
      .from(wmAccounts)
      .where(eq(wmAccounts.parentAccountId, account.id));

    return c.json({
      accounts: containers.map((ct) => ({
        id: ct.id,
        parentAccountId: ct.parentAccountId,
        name: ct.name,
        metadata: ct.metadata ?? {},
        memoryCount: ct.memoryCount,
        createdAt: ct.createdAt.toISOString(),
      })),
      total: containers.length,
    });
  });

  // ─── GET /containers/:id — get a specific container ───────────────────
  app.get("/containers/:id", async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");
    const containerId = c.req.param("id");

    try {
      requirePlan(account, ["pro", "team", "enterprise"]);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    const [container] = await db
      .select()
      .from(wmAccounts)
      .where(and(eq(wmAccounts.id, containerId), eq(wmAccounts.parentAccountId, account.id)))
      .limit(1);

    if (!container) {
      return c.json({ error: { code: "not_found", message: "Container not found" } }, 404);
    }

    const [[memoryRow], [keyRow]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmMemories)
        .where(and(eq(wmMemories.accountId, containerId), isNull(wmMemories.supersededBy))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmApiKeys)
        .where(and(eq(wmApiKeys.accountId, containerId), isNull(wmApiKeys.revokedAt))),
    ]);

    return c.json({
      account: {
        id: container.id,
        parentAccountId: container.parentAccountId,
        name: container.name,
        metadata: container.metadata ?? {},
        memoryCount: memoryRow?.count ?? 0,
        activeKeyCount: keyRow?.count ?? 0,
        createdAt: container.createdAt.toISOString(),
      },
    });
  });

  // ─── DELETE /containers/:id/keys/:keyId — revoke a container key ──────
  app.delete("/containers/:id/keys/:keyId", async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");
    const containerId = c.req.param("id");
    const keyId = c.req.param("keyId");

    const [targetKey] = await db
      .select({ id: wmApiKeys.id })
      .from(wmApiKeys)
      .innerJoin(wmAccounts, eq(wmApiKeys.accountId, wmAccounts.id))
      .where(
        and(
          eq(wmApiKeys.id, keyId),
          eq(wmApiKeys.accountId, containerId),
          eq(wmAccounts.parentAccountId, account.id),
          isNull(wmApiKeys.revokedAt)
        )
      )
      .limit(1);

    if (!targetKey) {
      return c.json({ error: { code: "not_found", message: "Key not found" } }, 404);
    }

    const now = new Date();
    await db.update(wmApiKeys).set({ revokedAt: now }).where(eq(wmApiKeys.id, keyId));

    return c.json({ revoked: true, revokedAt: now.toISOString() });
  });

  // ─── DELETE /containers/:id — delete a container ──────────────────────
  app.delete(
    "/containers/:id",
    zValidator("json", DeleteContainerSchema, zodErrorHook),
    async (c) => {
      const scopeError = requireAdminScope(c);
      if (scopeError) return c.json(scopeError, 401);

      const db = c.get("db");
      const account = c.get("account");
      const containerId = c.req.param("id");

      const [container] = await db
        .select({ id: wmAccounts.id })
        .from(wmAccounts)
        .where(and(eq(wmAccounts.id, containerId), eq(wmAccounts.parentAccountId, account.id)))
        .limit(1);

      if (!container) {
        return c.json({ error: { code: "not_found", message: "Container not found" } }, 404);
      }

      // FK CASCADE handles memories, end users, keys
      await db.delete(wmAccounts).where(eq(wmAccounts.id, containerId));

      return c.json({ deleted: true });
    }
  );

  return app;
}
