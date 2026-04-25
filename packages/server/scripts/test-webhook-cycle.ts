// End-to-end webhook simulation: fire customer.subscription.updated then
// customer.subscription.deleted with a real local subscription id, then
// verify the wm_accounts row reflects each transition.
//
// Run: pnpm tsx scripts/test-webhook-cycle.ts <account-uuid> <sub-id>

import { config } from "dotenv";
import { resolve } from "node:path";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { wmAccounts } from "../src/db/schema";

config({ path: resolve(process.cwd(), ".env.local") });

const ENDPOINT = "http://127.0.0.1:8787/webhooks/stripe";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const PRICE_BASIC = process.env.STRIPE_PRICE_BASIC!;
const DB_URL = process.env.DATABASE_URL!;

const accountId = process.argv[2];
const subId = process.argv[3];
if (!accountId || !subId) {
  console.error("Usage: pnpm tsx scripts/test-webhook-cycle.ts <account-uuid> <sub-id>");
  process.exit(1);
}

async function postEvent(label: string, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": sig },
    body,
  });
  console.log(`[${label}] status=${res.status} body=${await res.text()}`);
}

async function readAccount(db: ReturnType<typeof createDb>) {
  const [row] = await db
    .select({
      planTier: wmAccounts.planTier,
      planStatus: wmAccounts.planStatus,
      memoryLimit: wmAccounts.memoryLimit,
      currentPeriodEnd: wmAccounts.currentPeriodEnd,
      stripeSubscriptionId: wmAccounts.stripeSubscriptionId,
    })
    .from(wmAccounts)
    .where(eq(wmAccounts.id, accountId))
    .limit(1);
  return row;
}

async function main() {
  const db = createDb(DB_URL);
  console.log("before:", await readAccount(db));

  // 1) subscription.updated → downgrade pro → basic, status active
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  await postEvent("subscription.updated → basic", {
    id: "evt_cycle_updated",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: subId,
        status: "active",
        current_period_end: periodEnd,
        items: { data: [{ price: { id: PRICE_BASIC }, current_period_end: periodEnd }] },
      },
    },
    livemode: false,
    created: Math.floor(Date.now() / 1000),
  });
  console.log("after-updated:", await readAccount(db));

  // 2) invoice.payment_failed → status=past_due (matched by customer id)
  // We don't know customer id from sub id without a real Stripe call, so
  // skip this in the cycle; it's covered by the smoke test above.

  // 3) subscription.deleted → reset to free, clear sub id
  await postEvent("subscription.deleted", {
    id: "evt_cycle_deleted",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: subId,
        status: "canceled",
        items: { data: [{ price: { id: PRICE_BASIC } }] },
      },
    },
    livemode: false,
    created: Math.floor(Date.now() / 1000),
  });
  console.log("after-deleted:", await readAccount(db));

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
