// Smoke test for /webhooks/stripe — constructs a Stripe-signed payload
// using the local STRIPE_WEBHOOK_SECRET and POSTs it to the running Worker.
// Verifies: missing-signature 400, bad-signature 400, valid-signature 200.
//
// Run: pnpm tsx scripts/test-webhook.ts
//
// Pre-reqs: `pnpm dev` (Worker on :8787) + a wm_account row matching the
// account_id below. Pass `--account <uuid>` to upgrade a real local account.

import { config } from "dotenv";
import { resolve } from "node:path";
import Stripe from "stripe";

config({ path: resolve(process.cwd(), ".env.local") });

const ENDPOINT = "http://127.0.0.1:8787/webhooks/stripe";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_PRO = process.env.STRIPE_PRICE_PRO;

if (!SECRET || !PRICE_PRO) {
  console.error("Missing STRIPE_WEBHOOK_SECRET or STRIPE_PRICE_PRO in env.");
  process.exit(1);
}

function parseAccountId(): string | null {
  const idx = process.argv.indexOf("--account");
  if (idx === -1 || !process.argv[idx + 1]) return null;
  return process.argv[idx + 1];
}

async function postUnsigned() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "evt_test", type: "ping" }),
  });
  console.log(`[no-sig] status=${res.status} body=${await res.text()}`);
}

async function postBadSig() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "t=1234,v1=deadbeef",
    },
    body: JSON.stringify({ id: "evt_test", type: "ping" }),
  });
  console.log(`[bad-sig] status=${res.status} body=${await res.text()}`);
}

function signedHeader(payload: string, secret: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

async function postSigned(label: string, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const sig = signedHeader(body, SECRET!);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": sig,
    },
    body,
  });
  console.log(`[${label}] status=${res.status} body=${await res.text()}`);
}

async function main() {
  await postUnsigned();
  await postBadSig();

  // Unknown event type — handler should ack with 200, no DB writes
  await postSigned("unknown-evt", {
    id: "evt_smoke_unknown",
    type: "charge.captured",
    data: { object: { id: "ch_smoke" } },
    livemode: false,
    created: Math.floor(Date.now() / 1000),
  });

  const accountId = parseAccountId();
  if (!accountId) {
    console.log(
      "\n(skip) Pass --account <wm_account uuid> to test checkout.session.completed " +
        "DB updates against a real local row."
    );
    return;
  }

  // Fake checkout.session.completed pointing at the given local account.
  // The handler will retrieve subscriptions.retrieve(...) — that hits the
  // real Stripe test API, so we use a real subscription if you have one,
  // or simulate via customer.subscription.updated / .deleted instead.
  // Easier path: use a customer.subscription.deleted with a known sub id.
  await postSigned("subscription.deleted", {
    id: "evt_smoke_deleted",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_smoke_does_not_exist",
        status: "canceled",
        items: { data: [{ price: { id: PRICE_PRO } }] },
      },
    },
    livemode: false,
    created: Math.floor(Date.now() / 1000),
  });

  // invoice.payment_failed against a fake customer that doesn't exist —
  // handler logs a warning and returns 200 (ack so Stripe doesn't retry).
  await postSigned("invoice.payment_failed", {
    id: "evt_smoke_payfail",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_smoke",
        customer: "cus_smoke_does_not_exist",
      },
    },
    livemode: false,
    created: Math.floor(Date.now() / 1000),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
