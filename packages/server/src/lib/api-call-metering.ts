// API call metering. Tracks per-account requests across a 30-day rolling
// window. The auth middleware reads (to enforce 429) and writes (fire-and-
// forget via waitUntil) on every authenticated request.
//
// Sub-account requests count against the parent account's counter — the
// route receives a sub-account `account` row, but the metering target is
// the parent (consistent with checkMemoryQuota).

import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { wmAccounts } from "../db/schema";

export const PERIOD_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;

export type MeteringSnapshot = {
  current: number;
  limit: number;
  resetsAt: Date;
};

/**
 * Compute the snapshot used for both the 429 response body and read-only
 * surfaces (usage/billing endpoints). Pure: no DB writes.
 */
export function meteringSnapshot(account: {
  apiCallsThisPeriod: number;
  monthlyApiCallLimit: number;
  currentPeriodStart: Date;
}): MeteringSnapshot {
  const periodStart = account.currentPeriodStart.getTime();
  const periodExpired = Date.now() - periodStart >= PERIOD_LENGTH_MS;
  // Once the period rolls over, the count agents observe should be 0 even
  // before the next request triggers the actual reset write.
  const current = periodExpired ? 0 : account.apiCallsThisPeriod;
  const resetsAt = new Date(periodStart + PERIOD_LENGTH_MS);
  return { current, limit: account.monthlyApiCallLimit, resetsAt };
}

/**
 * Returns true when a fresh request should be rejected with 429. Uses the
 * same period-rollover logic as the snapshot so a request that arrives just
 * after the window expires sails through (the increment will reset the row).
 */
export function isOverLimit(account: {
  apiCallsThisPeriod: number;
  monthlyApiCallLimit: number;
  currentPeriodStart: Date;
}): boolean {
  const snapshot = meteringSnapshot(account);
  return snapshot.current >= snapshot.limit;
}

/**
 * Increment the per-period counter. If the stored period_start is older
 * than 30 days, this also resets the counter to 1 and rolls the period
 * forward. Single SQL round-trip via CASE expressions so concurrent
 * requests can't race the reset window.
 */
export async function incrementApiCallCount(
  db: Database,
  meteredAccountId: string
): Promise<void> {
  const periodCutoffSql = sql`now() - interval '30 days'`;
  await db
    .update(wmAccounts)
    .set({
      apiCallsThisPeriod: sql`CASE
        WHEN ${wmAccounts.currentPeriodStart} < ${periodCutoffSql} THEN 1
        ELSE ${wmAccounts.apiCallsThisPeriod} + 1
      END`,
      currentPeriodStart: sql`CASE
        WHEN ${wmAccounts.currentPeriodStart} < ${periodCutoffSql} THEN now()
        ELSE ${wmAccounts.currentPeriodStart}
      END`,
    })
    .where(eq(wmAccounts.id, meteredAccountId));
}
