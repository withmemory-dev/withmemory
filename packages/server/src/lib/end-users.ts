import { eq, and } from "drizzle-orm";
import type { Database } from "../db/client";
import { wmEndUsers, type WmEndUser } from "../db/schema";

/**
 * Look up an end user by (accountId, externalId). Returns null if not found.
 */
export async function findEndUser(
  db: Database,
  accountId: string,
  externalId: string
): Promise<WmEndUser | null> {
  const [endUser] = await db
    .select()
    .from(wmEndUsers)
    .where(and(eq(wmEndUsers.accountId, accountId), eq(wmEndUsers.externalId, externalId)))
    .limit(1);

  return endUser ?? null;
}

/**
 * Upsert an end user by (accountId, externalId) and return the row.
 *
 * Uses insert-or-ignore + select, which is one round trip more than
 * a single upsert with RETURNING but works correctly with the
 * existing unique constraint semantics and matches the pattern
 * already established in set.ts.
 */
export async function ensureEndUser(
  db: Database,
  accountId: string,
  externalId: string
): Promise<WmEndUser> {
  await db
    .insert(wmEndUsers)
    .values({ accountId, externalId })
    .onConflictDoNothing({ target: [wmEndUsers.accountId, wmEndUsers.externalId] });

  const [endUser] = await db
    .select()
    .from(wmEndUsers)
    .where(and(eq(wmEndUsers.accountId, accountId), eq(wmEndUsers.externalId, externalId)))
    .limit(1);

  if (!endUser) {
    throw new Error(
      `ensureEndUser: failed to upsert or find end user for ` +
        `account=${accountId} externalId=${externalId}`
    );
  }

  return endUser;
}
