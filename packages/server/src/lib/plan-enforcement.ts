import { and, isNull, sql, eq, or, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { wmMemories, wmAccounts } from "../db/schema";
import type { PlanTier } from "../db/schema";

export type { PlanTier };

/**
 * Check whether the account has room for `additionalMemories` new memories.
 * Throws a structured error (matching the server's standard envelope) if
 * the account's memory_limit would be exceeded.
 *
 * For sub-accounts, quota is checked against the parent account's limit —
 * memories across the parent and all its sub-accounts are summed together.
 * For top-level (parent) accounts, the same summing logic applies: the
 * account's own memories plus all sub-account memories count toward the limit.
 *
 * The `account` parameter comes from auth middleware (already loaded via
 * Drizzle join), so this function issues at most two DB queries (resolve
 * parent + count).
 *
 * Race condition note: two concurrent writes can both pass this check and
 * both succeed, transiently exceeding the limit by a small amount. This is
 * acceptable for now. A DB-level constraint or advisory lock is the
 * proper fix; tracked in docs/followups.md.
 */
export async function checkMemoryQuota(
  db: Database,
  account: {
    id: string;
    memoryLimit: number;
    planTier: PlanTier;
    parentAccountId: string | null;
  },
  additionalMemories: number = 1
): Promise<void> {
  // Resolve the parent account and its limit
  let parentId: string;
  let limit: number;
  let planTier: PlanTier;

  if (account.parentAccountId) {
    // This is a sub-account — look up the parent for its limit
    const [parent] = await db
      .select({
        id: wmAccounts.id,
        memoryLimit: wmAccounts.memoryLimit,
        planTier: wmAccounts.planTier,
      })
      .from(wmAccounts)
      .where(eq(wmAccounts.id, account.parentAccountId))
      .limit(1);

    if (!parent) {
      // Orphaned sub-account — shouldn't happen with FK CASCADE, but be safe
      throw PlanEnforcementError.quotaExceeded({
        current: 0,
        limit: 0,
        planTier: account.planTier,
        quotaScope: "container",
      });
    }

    parentId = parent.id;
    limit = parent.memoryLimit;
    planTier = parent.planTier as PlanTier;
  } else {
    parentId = account.id;
    limit = account.memoryLimit;
    planTier = account.planTier;
  }

  // Count active memories across parent + all sub-accounts
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wmMemories)
    .where(
      and(
        sql`${wmMemories.accountId} IN (
          SELECT id FROM wm_accounts
          WHERE id = ${parentId} OR parent_account_id = ${parentId}
        )`,
        isNull(wmMemories.supersededBy)
      )
    );

  const current = countRow?.count ?? 0;

  if (current + additionalMemories > limit) {
    throw PlanEnforcementError.quotaExceeded({
      current,
      limit,
      planTier,
      quotaScope: account.parentAccountId ? "container" : "parent_account",
    });
  }
}

/**
 * Plan tier gate. Throws if the account's tier is not in the allowed list.
 * Pure function — operates on the account object already loaded by auth
 * middleware (plan columns auto-propagate via the Drizzle join).
 */
export function requirePlan(
  account: { planTier: PlanTier },
  allowedTiers: readonly PlanTier[]
): void {
  if (!allowedTiers.includes(account.planTier)) {
    throw PlanEnforcementError.planRequired({
      currentTier: account.planTier,
      requiredTiers: allowedTiers,
    });
  }
}

/**
 * Structured error for plan enforcement failures. Route handlers catch this
 * and return the standard `{ error: { code, message, details } }` envelope
 * with HTTP 403.
 *
 * Constructed via static factories only — prevents positional arg mistakes.
 */
export class PlanEnforcementError extends Error {
  readonly code: "quota_exceeded" | "plan_required";
  readonly details: Record<string, unknown>;

  private constructor(
    code: "quota_exceeded" | "plan_required",
    message: string,
    details: Record<string, unknown>
  ) {
    super(message);
    this.name = "PlanEnforcementError";
    this.code = code;
    this.details = details;
  }

  static quotaExceeded(opts: {
    current: number;
    limit: number;
    planTier: PlanTier;
    quotaScope?: "parent_account" | "container";
  }): PlanEnforcementError {
    return new PlanEnforcementError(
      "quota_exceeded",
      `Memory limit reached (${opts.current} / ${opts.limit}).`,
      {
        current: opts.current,
        limit: opts.limit,
        plan_tier: opts.planTier,
        quota_scope: opts.quotaScope ?? "parent_account",
        recovery_options: [
          {
            action: "remove_memories",
            description:
              "Remove old memories with memory.list() + memory.remove() or memory.delete()",
          },
          {
            action: "supersede_duplicates",
            description: "Dedup by re-adding with the same key",
          },
          {
            action: "upgrade_plan",
            url: "https://app.withmemory.dev/settings/billing",
            description: "Upgrade your plan for a higher memory limit",
          },
        ],
      }
    );
  }

  static planRequired(opts: {
    currentTier: PlanTier;
    requiredTiers: readonly PlanTier[];
  }): PlanEnforcementError {
    return new PlanEnforcementError(
      "plan_required",
      `This feature requires one of: ${opts.requiredTiers.join(", ")}. Current plan: ${opts.currentTier}.`,
      {
        current_tier: opts.currentTier,
        required_tiers: opts.requiredTiers,
        recovery_options: [
          {
            action: "upgrade_plan",
            url: "https://app.withmemory.dev/settings/billing",
            description: "Upgrade to a plan that includes this feature",
          },
        ],
      }
    );
  }

  /**
   * Convert to the JSON response body that route handlers return with
   * HTTP 403.
   */
  toResponseBody(): {
    error: { code: string; message: string; details: Record<string, unknown>; request_id?: string };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}
