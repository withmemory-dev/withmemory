import type { Context, Next } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Database } from "../db/client";

const { wmApiKeys, wmAccounts } = schema;
import { sha256Hex } from "../lib/hash";
import {
  incrementApiCallCount,
  isOverLimit,
  meteringSnapshot,
} from "../lib/api-call-metering";

export function authMiddleware(db: Database) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");

    const requestId = c.get("requestId");

    if (!authHeader) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: "Missing Authorization header",
            request_id: requestId,
          },
        },
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
            request_id: requestId,
          },
        },
        401
      );
    }
    const hashedKey = await sha256Hex(rawKey);

    // Only match non-revoked keys (soft revocation via revoked_at column)
    const result = await db
      .select({
        apiKey: wmApiKeys,
        account: wmAccounts,
      })
      .from(wmApiKeys)
      .innerJoin(wmAccounts, eq(wmApiKeys.accountId, wmAccounts.id))
      .where(and(eq(wmApiKeys.keyHash, hashedKey), isNull(wmApiKeys.revokedAt)))
      .limit(1);

    if (result.length === 0) {
      return c.json(
        { error: { code: "unauthorized", message: "Invalid API key", request_id: requestId } },
        401
      );
    }

    const { apiKey, account } = result[0];

    // Check key expiry — expired keys return a distinct error code so
    // agents can distinguish "key expired" from "key invalid"
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      return c.json(
        { error: { code: "key_expired", message: "API key has expired", request_id: requestId } },
        401
      );
    }

    c.set("account", account);
    c.set("apiKey", apiKey);

    // API call metering — sub-account traffic counts against the parent.
    // Load the parent row so the rate-limit check sees the parent's counter
    // and limit; otherwise use the calling account directly.
    let meteredAccount = account;
    if (account.parentAccountId) {
      const [parent] = await db
        .select()
        .from(wmAccounts)
        .where(eq(wmAccounts.id, account.parentAccountId))
        .limit(1);
      if (parent) meteredAccount = parent;
    }

    if (isOverLimit(meteredAccount)) {
      const snapshot = meteringSnapshot(meteredAccount);
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: `Monthly API call limit reached (${snapshot.current.toLocaleString()} / ${snapshot.limit.toLocaleString()})`,
            details: {
              current: snapshot.current,
              limit: snapshot.limit,
              resets_at: snapshot.resetsAt.toISOString(),
              recovery_options: [
                {
                  action: "wait",
                  description: "Limit resets at the start of your next billing period",
                },
                {
                  action: "upgrade_plan",
                  url: "https://app.withmemory.dev/settings",
                  api: "POST /v1/account/checkout",
                  description:
                    "Upgrade your plan for a higher monthly API call limit. Agents can call POST /v1/account/checkout to mint a Checkout URL and surface it to the principal.",
                },
              ],
            },
            request_id: requestId,
          },
        },
        429
      );
    }

    // Read optional attribution header for observability. Strip control chars
    // and cap length so a crafted value can't inject newlines into log lines
    // or blow out downstream log parsers.
    const rawClientId = c.req.header("X-WithMemory-Client") || "";
    const clientId = rawClientId.replace(/[\r\n\t\x00-\x1f]/g, "").slice(0, 128) || null;
    c.set("clientId", clientId);
    console.log(
      `[client: ${clientId || "unknown"}] ${c.req.method} ${c.req.path} account=${account.id}`
    );

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

    // Fire-and-forget API call counter increment. Concurrent requests can
    // slightly over-count — same tolerance as last_used_at above.
    c.executionCtx.waitUntil(
      incrementApiCallCount(db, meteredAccount.id)
        .then(() => {})
        .catch(() => {})
    );

    await next();
  };
}
