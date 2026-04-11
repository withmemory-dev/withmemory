import { and, isNull, sql, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { wmMemories } from "../db/schema";
import type { PlanTier } from "../db/schema";

export type { PlanTier };

/**
 * Check whether the account has room for `additionalMemories` new memories.
 * Throws a structured error (matching the server's standard envelope) if
 * the account's memory_limit would be exceeded.
 *
 * Called before writes — rejects early so we never touch the DB or
 * embeddings API when the account is over quota.
 *
 * The `account` parameter comes from auth middleware (already loaded via
 * Drizzle join), so this function only issues one DB query (the count).
 *
 * Race condition note: two concurrent writes can both pass this check and
 * both succeed, transiently exceeding the limit by a small amount. This is
 * acceptable for Session 10. A DB-level constraint or advisory lock is the
 * proper fix; deferred to a followup.
 */
export async function checkMemoryQuota(
  db: Database,
  account: { id: string; memoryLimit: number; planTier: PlanTier },
  additionalMemories: number = 1
): Promise<void> {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wmMemories)
    .where(
      and(
        eq(wmMemories.accountId, account.id),
        isNull(wmMemories.supersededBy)
      )
    );

  const current = countRow?.count ?? 0;
  const limit = account.memoryLimit;

  if (current + additionalMemories > limit) {
    throw PlanEnforcementError.quotaExceeded({
      current,
      limit,
      planTier: account.planTier,
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
  }): PlanEnforcementError {
    return new PlanEnforcementError(
      "quota_exceeded",
      `Memory limit reached (${opts.current} / ${opts.limit}). Upgrade to increase your limit.`,
      { current: opts.current, limit: opts.limit, plan_tier: opts.planTier }
    );
  }

  static planRequired(opts: {
    currentTier: PlanTier;
    requiredTiers: readonly PlanTier[];
  }): PlanEnforcementError {
    return new PlanEnforcementError(
      "plan_required",
      `This feature requires one of: ${opts.requiredTiers.join(", ")}. Current plan: ${opts.currentTier}.`,
      { current_tier: opts.currentTier, required_tiers: opts.requiredTiers }
    );
  }

  /**
   * Convert to the JSON response body that route handlers return with
   * HTTP 403.
   */
  toResponseBody(): {
    error: { code: string; message: string; details: Record<string, unknown> };
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
