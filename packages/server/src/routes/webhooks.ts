import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { createDb } from "../db/client";
import { createStripeClient } from "../lib/stripe";
import { PLAN_LIMITS, priceIdToTier } from "../lib/plan-tiers";
import * as schema from "../db/schema";
import type { WorkerEnv, AppVariables } from "../types";
import type { PlanStatus, PlanTier } from "../db/schema";

const { wmAccounts } = schema;

// Map Stripe subscription status → our plan_status enum. Stripe statuses we
// don't track explicitly fall back to "active" (e.g. "incomplete" early in a
// just-created subscription) or "canceled" (terminal states), which is
// enough resolution for the agent-facing recovery flow.
function mapStripeStatus(s: Stripe.Subscription.Status): PlanStatus {
  switch (s) {
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "trialing":
      return "trialing";
    default:
      // "incomplete" / "paused" — treat as active until something else moves it
      return "active";
  }
}

function periodEndFrom(sub: Stripe.Subscription): Date | null {
  // Stripe API switched the field shape between versions. Some versions
  // expose the period on the subscription itself; newer ones expose it on
  // each subscription item. We try both, and we cast through `unknown`
  // because the SDK type generation lags the wire shape we actually see.
  const subAny = sub as unknown as { current_period_end?: number };
  if (typeof subAny.current_period_end === "number") {
    return new Date(subAny.current_period_end * 1000);
  }
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;
  if (item && typeof item.current_period_end === "number") {
    return new Date(item.current_period_end * 1000);
  }
  return null;
}

type AccountUpdate = Partial<typeof wmAccounts.$inferInsert>;

function applyTierLimits(tier: PlanTier, update: AccountUpdate): AccountUpdate {
  const limits = PLAN_LIMITS[tier];
  return {
    ...update,
    planTier: tier,
    memoryLimit: limits.memoryLimit,
    monthlyApiCallLimit: limits.monthlyApiCallLimit,
  };
}

export function webhookRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.post("/webhooks/stripe", async (c) => {
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      return c.json({ error: "missing stripe-signature header" }, 400);
    }

    const rawBody = await c.req.text();
    const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);

    let event: Stripe.Event;
    try {
      // constructEventAsync uses Web Crypto subtle.digest, which is what
      // Cloudflare Workers exposes. The synchronous variant pulls in Node's
      // `crypto` module and won't run on Workers.
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        c.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.warn("[webhook] signature verification failed:", String(err));
      return c.json({ error: "invalid signature" }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const customerId =
            typeof session.customer === "string"
              ? session.customer
              : session.customer?.id;
          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id;
          const accountId = session.client_reference_id;

          if (!customerId || !subscriptionId) {
            console.warn(
              "[webhook] checkout.session.completed missing customer or subscription",
              { sessionId: session.id }
            );
            break;
          }

          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const priceId = subscription.items.data[0]?.price.id;
          if (!priceId) {
            console.warn("[webhook] subscription has no price", { subscriptionId });
            break;
          }
          const tier = priceIdToTier(priceId, c.env);
          if (!tier) {
            console.warn("[webhook] price id not mapped to a tier", { priceId });
            break;
          }

          // Find the account: prefer the explicit client_reference_id we set
          // when creating the Checkout session; fall back to looking up by
          // stripe_customer_id in case this session was created elsewhere.
          let target: { id: string } | undefined;
          if (accountId) {
            const rows = await db
              .select({ id: wmAccounts.id })
              .from(wmAccounts)
              .where(eq(wmAccounts.id, accountId))
              .limit(1);
            target = rows[0];
          }
          if (!target) {
            const rows = await db
              .select({ id: wmAccounts.id })
              .from(wmAccounts)
              .where(eq(wmAccounts.stripeCustomerId, customerId))
              .limit(1);
            target = rows[0];
          }
          if (!target) {
            console.warn("[webhook] no wm_account for checkout session", {
              accountId,
              customerId,
            });
            break;
          }

          const update = applyTierLimits(tier, {
            planStatus: "active",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            currentPeriodEnd: periodEndFrom(subscription),
          });

          await db.update(wmAccounts).set(update).where(eq(wmAccounts.id, target.id));
          console.log(
            `[webhook] checkout.session.completed account=${target.id} tier=${tier}`
          );
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const priceId = subscription.items.data[0]?.price.id;
          if (!priceId) {
            console.warn("[webhook] subscription.updated has no price", {
              subscriptionId: subscription.id,
            });
            break;
          }
          const tier = priceIdToTier(priceId, c.env);
          if (!tier) {
            console.warn("[webhook] subscription.updated unmapped price", { priceId });
            break;
          }

          const rows = await db
            .select({ id: wmAccounts.id })
            .from(wmAccounts)
            .where(eq(wmAccounts.stripeSubscriptionId, subscription.id))
            .limit(1);
          const target = rows[0];
          if (!target) {
            console.warn("[webhook] no wm_account for subscription.updated", {
              subscriptionId: subscription.id,
            });
            break;
          }

          const update = applyTierLimits(tier, {
            planStatus: mapStripeStatus(subscription.status),
            currentPeriodEnd: periodEndFrom(subscription),
          });

          await db.update(wmAccounts).set(update).where(eq(wmAccounts.id, target.id));
          console.log(
            `[webhook] subscription.updated account=${target.id} tier=${tier} status=${subscription.status}`
          );
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const rows = await db
            .select({ id: wmAccounts.id })
            .from(wmAccounts)
            .where(eq(wmAccounts.stripeSubscriptionId, subscription.id))
            .limit(1);
          const target = rows[0];
          if (!target) {
            console.warn("[webhook] no wm_account for subscription.deleted", {
              subscriptionId: subscription.id,
            });
            break;
          }

          const limits = PLAN_LIMITS.free;
          await db
            .update(wmAccounts)
            .set({
              planTier: "free",
              planStatus: "canceled",
              stripeSubscriptionId: null,
              currentPeriodEnd: null,
              memoryLimit: limits.memoryLimit,
              monthlyApiCallLimit: limits.monthlyApiCallLimit,
            })
            .where(eq(wmAccounts.id, target.id));
          console.log(
            `[webhook] subscription.deleted account=${target.id} reset to free`
          );
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId =
            typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id;
          if (!customerId) break;

          const rows = await db
            .select({ id: wmAccounts.id })
            .from(wmAccounts)
            .where(eq(wmAccounts.stripeCustomerId, customerId))
            .limit(1);
          const target = rows[0];
          if (!target) {
            console.warn("[webhook] no wm_account for invoice.payment_failed", {
              customerId,
            });
            break;
          }

          await db
            .update(wmAccounts)
            .set({ planStatus: "past_due" })
            .where(eq(wmAccounts.id, target.id));
          console.log(`[webhook] invoice.payment_failed account=${target.id}`);
          break;
        }

        default:
          // Stripe sends a long tail of event types we don't care about; ack
          // them so it stops retrying.
          console.log(`[webhook] ignored event type ${event.type}`);
      }
    } catch (err) {
      console.error("[webhook] handler error:", err);
      // Return 500 so Stripe retries — but only on genuine handler errors,
      // not on signature/parse failures (which are 400 above and shouldn't
      // be retried).
      return c.json({ error: "handler error" }, 500);
    }

    return c.json({ received: true });
  });

  return app;
}
