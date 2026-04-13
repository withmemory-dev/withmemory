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

// ─── Sub-account limits per plan tier ──────────────────────────────────────
const SUB_ACCOUNT_LIMITS: Record<string, number> = {
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

  // Sub-accounts cannot call sub-account management endpoints
  if (account.parentAccountId !== null) {
    return {
      error: {
        code: "unauthorized",
        message: "Sub-accounts cannot manage other sub-accounts",
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

const CreateAccountSchema = z.object({
  name: z.string().min(1).max(255),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CreateKeySchema = z.object({
  issuedTo: z.string().min(1).max(255),
  scopes: z.string().optional(),
  expiresIn: z.number().int().min(1).max(31536000).optional(),
});

const DeleteAccountSchema = z.object({
  confirm: z.literal(true),
});

// ─── Route factory ──────────────────────────────────────────────────────────

export function subAccountsRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // ─── POST /sub-accounts — create a sub-account ───────────────────────
  app.post(
    "/sub-accounts",
    zValidator("json", CreateAccountSchema, zodErrorHook),
    async (c) => {
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

      // Check sub-account limit
      const limit = SUB_ACCOUNT_LIMITS[account.planTier] ?? 0;
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmAccounts)
        .where(eq(wmAccounts.parentAccountId, account.id));
      const current = countRow?.count ?? 0;

      if (current >= limit) {
        return c.json(
          {
            error: {
              code: "sub_account_limit_exceeded",
              message: `Sub-account limit reached (${current} / ${limit}). Upgrade to increase your limit.`,
              details: { current, limit, plan_tier: account.planTier },
            },
          },
          403
        );
      }

      // Sub-accounts use a generated email to satisfy the NOT NULL unique constraint.
      // Format: sub_{randomHex}@sub.withmemory.internal
      const subEmailSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const subEmail = `sub_${subEmailSuffix}@sub.withmemory.internal`;

      const [subAccount] = await db
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
            id: subAccount.id,
            parentAccountId: subAccount.parentAccountId,
            name: subAccount.name,
            metadata: subAccount.metadata ?? {},
            planTier: subAccount.planTier,
            memoryLimit: subAccount.memoryLimit,
            createdAt: subAccount.createdAt.toISOString(),
          },
        },
        201
      );
    }
  );

  // ─── POST /sub-accounts/:id/keys — mint a sub-account key ────────────
  app.post(
    "/sub-accounts/:id/keys",
    zValidator("json", CreateKeySchema, zodErrorHook),
    async (c) => {
      const scopeError = requireAdminScope(c);
      if (scopeError) return c.json(scopeError, 401);

      const db = c.get("db");
      const account = c.get("account");
      const apiKey = c.get("apiKey");
      const subAccountId = c.req.param("id");
      const { issuedTo, scopes, expiresIn } = c.req.valid("json");

      try {
        requirePlan(account, ["pro", "team", "enterprise"]);
      } catch (e) {
        if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
        throw e;
      }

      // Validate scopes: account:admin is not allowed on sub-account keys
      const resolvedScopes = scopes ?? "memory:read,memory:write";
      if (resolvedScopes.includes("account:admin")) {
        return c.json(
          {
            error: {
              code: "invalid_request",
              message: "Sub-account keys cannot have account:admin scope",
            },
          },
          400
        );
      }

      // Verify sub-account exists and belongs to this parent
      const [subAccount] = await db
        .select()
        .from(wmAccounts)
        .where(
          and(eq(wmAccounts.id, subAccountId), eq(wmAccounts.parentAccountId, account.id))
        )
        .limit(1);

      if (!subAccount) {
        return c.json({ error: { code: "not_found", message: "Sub-account not found" } }, 404);
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
          accountId: subAccountId,
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
    }
  );

  // ─── GET /sub-accounts — list sub-accounts ────────────────────────────
  app.get("/sub-accounts", async (c) => {
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

    // Fetch sub-accounts with memory counts via a subquery
    const subAccounts = await db
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
      accounts: subAccounts.map((sa) => ({
        id: sa.id,
        parentAccountId: sa.parentAccountId,
        name: sa.name,
        metadata: sa.metadata ?? {},
        memoryCount: sa.memoryCount,
        createdAt: sa.createdAt.toISOString(),
      })),
      total: subAccounts.length,
    });
  });

  // ─── GET /sub-accounts/:id — get a specific sub-account ───────────────
  app.get("/sub-accounts/:id", async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");
    const subAccountId = c.req.param("id");

    try {
      requirePlan(account, ["pro", "team", "enterprise"]);
    } catch (e) {
      if (e instanceof PlanEnforcementError) return c.json(e.toResponseBody(), 403);
      throw e;
    }

    const [subAccount] = await db
      .select()
      .from(wmAccounts)
      .where(
        and(eq(wmAccounts.id, subAccountId), eq(wmAccounts.parentAccountId, account.id))
      )
      .limit(1);

    if (!subAccount) {
      return c.json({ error: { code: "not_found", message: "Sub-account not found" } }, 404);
    }

    // Count active memories and active keys
    const [[memoryRow], [keyRow]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmMemories)
        .where(
          and(eq(wmMemories.accountId, subAccountId), isNull(wmMemories.supersededBy))
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(wmApiKeys)
        .where(
          and(eq(wmApiKeys.accountId, subAccountId), isNull(wmApiKeys.revokedAt))
        ),
    ]);

    return c.json({
      account: {
        id: subAccount.id,
        parentAccountId: subAccount.parentAccountId,
        name: subAccount.name,
        metadata: subAccount.metadata ?? {},
        memoryCount: memoryRow?.count ?? 0,
        activeKeyCount: keyRow?.count ?? 0,
        createdAt: subAccount.createdAt.toISOString(),
      },
    });
  });

  // ─── DELETE /sub-accounts/:id/keys/:keyId — revoke a sub-account key ──
  app.delete("/sub-accounts/:id/keys/:keyId", async (c) => {
    const scopeError = requireAdminScope(c);
    if (scopeError) return c.json(scopeError, 401);

    const db = c.get("db");
    const account = c.get("account");
    const subAccountId = c.req.param("id");
    const keyId = c.req.param("keyId");

    // Verify the sub-account belongs to this parent AND the key belongs to
    // the sub-account. Use a single query to prevent UUID enumeration —
    // all three failure cases return the same 404.
    const [targetKey] = await db
      .select({ id: wmApiKeys.id })
      .from(wmApiKeys)
      .innerJoin(wmAccounts, eq(wmApiKeys.accountId, wmAccounts.id))
      .where(
        and(
          eq(wmApiKeys.id, keyId),
          eq(wmApiKeys.accountId, subAccountId),
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

  // ─── DELETE /sub-accounts/:id — delete a sub-account ──────────────────
  app.delete(
    "/sub-accounts/:id",
    zValidator("json", DeleteAccountSchema, zodErrorHook),
    async (c) => {
      const scopeError = requireAdminScope(c);
      if (scopeError) return c.json(scopeError, 401);

      const db = c.get("db");
      const account = c.get("account");
      const subAccountId = c.req.param("id");

      const [subAccount] = await db
        .select({ id: wmAccounts.id })
        .from(wmAccounts)
        .where(
          and(eq(wmAccounts.id, subAccountId), eq(wmAccounts.parentAccountId, account.id))
        )
        .limit(1);

      if (!subAccount) {
        return c.json({ error: { code: "not_found", message: "Sub-account not found" } }, 404);
      }

      // FK CASCADE handles memories, end users, keys
      await db.delete(wmAccounts).where(eq(wmAccounts.id, subAccountId));

      return c.json({ deleted: true });
    }
  );

  return app;
}
