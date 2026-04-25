import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { zodErrorHook } from "../../lib/validation";
import { requirePlan, PlanEnforcementError } from "../../lib/plan-enforcement";
import { requireScopes } from "../../lib/scopes";
import { createStripeClient } from "../../lib/stripe";
import { PLAN_LIMITS, tierToPriceId } from "../../lib/plan-tiers";

const { wmAccounts, wmMemories } = schema;

const CONTAINER_LIMITS: Record<string, number | null> = {
  free: 0,
  basic: 0,
  pro: 10,
  team: 100,
  enterprise: null, // unlimited
};

const DEFAULT_DASHBOARD_URL = "https://app.withmemory.dev";

const CheckoutSchema = z
  .object({ tier: z.enum(["basic", "pro"]) })
  .strict();
const checkoutValidator = zValidator("json", CheckoutSchema, zodErrorHook);

const SetPromptSchema = z
  .object({
    prompt: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(1).max(32768)),
  })
  .strict();

const setPromptValidator = zValidator("json", SetPromptSchema, zodErrorHook);

export function accountRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  // GET /account — whoami: key scopes, plan tier, account metadata
  app.get("/account", async (c) => {
    const scopeError = requireScopes(c, "memory:read");
    if (scopeError) return c.json(scopeError, 403);

    const account = c.get("account");
    const apiKey = c.get("apiKey");

    return c.json({
      account: {
        id: account.id,
        email: account.email,
        planTier: account.planTier,
        planStatus: account.planStatus,
        memoryLimit: account.memoryLimit,
        monthlyApiCallLimit: account.monthlyApiCallLimit,
        createdAt: account.createdAt.toISOString(),
      },
      key: {
        id: apiKey.id,
        scopes: apiKey.scopes,
        name: apiKey.name,
        createdAt: apiKey.createdAt.toISOString(),
        expiresAt: apiKey.expiresAt?.toISOString() ?? null,
      },
      request_id: c.get("requestId"),
    });
  });

  // GET /account/usage — current quota usage
  app.get("/account/usage", async (c) => {
    const scopeError = requireScopes(c, "memory:read");
    if (scopeError) return c.json(scopeError, 403);

    const db = c.get("db");
    const account = c.get("account");

    const [memoryCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmMemories)
      .where(and(eq(wmMemories.accountId, account.id), isNull(wmMemories.supersededBy)));

    const [containerCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmAccounts)
      .where(eq(wmAccounts.parentAccountId, account.id));

    const containerLimit = CONTAINER_LIMITS[account.planTier] ?? 0;

    return c.json({
      usage: {
        memoryCount: memoryCountRow?.count ?? 0,
        memoryLimit: account.memoryLimit,
        containerCount: containerCountRow?.count ?? 0,
        containerLimit,
      },
      request_id: c.get("requestId"),
    });
  });

  // POST /account/extraction-prompt — set custom extraction prompt
  app.post("/account/extraction-prompt", setPromptValidator, async (c) => {
    const scopeError = requireScopes(c, "account:admin");
    if (scopeError) return c.json(scopeError, 403);

    const db = c.get("db");
    const account = c.get("account");
    const { prompt } = c.req.valid("json");

    // Plan gate: custom extraction prompts require pro tier or above
    try {
      requirePlan(account, ["pro", "team", "enterprise"]);
    } catch (e) {
      if (e instanceof PlanEnforcementError) {
        const body = e.toResponseBody();
        body.error.request_id = c.get("requestId");
        return c.json(body, 403);
      }
      throw e;
    }

    await db
      .update(wmAccounts)
      .set({ extractionPrompt: prompt })
      .where(eq(wmAccounts.id, account.id));

    return c.json({ extractionPrompt: { prompt, source: "custom" }, request_id: c.get("requestId") });
  });

  // GET /account/extraction-prompt — read current prompt state
  app.get("/account/extraction-prompt", async (c) => {
    const scopeError = requireScopes(c, "memory:read");
    if (scopeError) return c.json(scopeError, 403);

    const account = c.get("account");

    if (account.extractionPrompt) {
      return c.json({
        extractionPrompt: { prompt: account.extractionPrompt, source: "custom" },
        request_id: c.get("requestId"),
      });
    }

    return c.json({ extractionPrompt: { prompt: null, source: "default" }, request_id: c.get("requestId") });
  });

  // DELETE /account/extraction-prompt — reset to default
  app.delete("/account/extraction-prompt", async (c) => {
    const scopeError = requireScopes(c, "account:admin");
    if (scopeError) return c.json(scopeError, 403);

    const db = c.get("db");
    const account = c.get("account");

    await db
      .update(wmAccounts)
      .set({ extractionPrompt: null })
      .where(eq(wmAccounts.id, account.id));

    return c.json({ result: { reset: true }, request_id: c.get("requestId") });
  });

  // POST /account/checkout — create a Stripe Checkout session for upgrade
  app.post("/account/checkout", checkoutValidator, async (c) => {
    const scopeError = requireScopes(c, "account:admin");
    if (scopeError) return c.json(scopeError, 403);

    const account = c.get("account");
    const requestId = c.get("requestId");
    const { tier } = c.req.valid("json");

    // Already on a paid plan with a live subscription — agents should land
    // on the Stripe Billing Portal for plan changes, not a fresh checkout
    // (which would create a second subscription).
    if (
      account.stripeSubscriptionId &&
      (account.planStatus === "active" || account.planStatus === "trialing")
    ) {
      return c.json(
        {
          error: {
            code: "subscription_exists",
            message:
              "Account already has an active subscription. Use POST /v1/account/billing-portal to change plans.",
            request_id: requestId,
          },
        },
        409
      );
    }

    const priceId = tierToPriceId(tier, c.env);
    if (!priceId) {
      return c.json(
        {
          error: {
            code: "tier_not_configured",
            message: `Stripe price for tier "${tier}" is not configured on the server.`,
            request_id: requestId,
          },
        },
        500
      );
    }

    const dashboardUrl = c.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
    const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        // client_reference_id is the bridge from "human paid via browser"
        // back to "which wm_account row to update" when the webhook fires.
        client_reference_id: account.id,
        // Reuse an existing customer when we already have one — keeps the
        // Stripe customer record stable across upgrades / renewals.
        ...(account.stripeCustomerId
          ? { customer: account.stripeCustomerId }
          : { customer_email: account.email }),
        // Redundant lookup path on the subscription itself in case
        // client_reference_id is dropped on the line item path.
        subscription_data: { metadata: { wm_account_id: account.id } },
        success_url: `${dashboardUrl}/settings?checkout=success`,
        cancel_url: `${dashboardUrl}/settings`,
        allow_promotion_codes: true,
      });

      if (!session.url) {
        return c.json(
          {
            error: {
              code: "checkout_failed",
              message: "Stripe did not return a checkout URL.",
              request_id: requestId,
            },
          },
          502
        );
      }

      return c.json({ checkout: { url: session.url, sessionId: session.id }, request_id: requestId });
    } catch (err) {
      console.error("checkout.create error:", err);
      return c.json(
        {
          error: {
            code: "checkout_failed",
            message: "Failed to create Stripe Checkout session.",
            request_id: requestId,
          },
        },
        502
      );
    }
  });

  // POST /account/billing-portal — create a Stripe Billing Portal session
  app.post("/account/billing-portal", async (c) => {
    const scopeError = requireScopes(c, "account:admin");
    if (scopeError) return c.json(scopeError, 403);

    const account = c.get("account");
    const requestId = c.get("requestId");

    if (!account.stripeCustomerId) {
      return c.json(
        {
          error: {
            code: "no_stripe_customer",
            message:
              "Account has no Stripe customer yet. Run POST /v1/account/checkout first.",
            details: {
              recovery_options: [
                {
                  action: "checkout",
                  description:
                    "Create a Checkout session via POST /v1/account/checkout to subscribe to a paid plan.",
                },
              ],
            },
            request_id: requestId,
          },
        },
        409
      );
    }

    const dashboardUrl = c.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
    const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: account.stripeCustomerId,
        return_url: `${dashboardUrl}/settings`,
      });

      return c.json({ portal: { url: session.url }, request_id: requestId });
    } catch (err) {
      console.error("billing-portal.create error:", err);
      return c.json(
        {
          error: {
            code: "billing_portal_failed",
            message: "Failed to create Stripe Billing Portal session.",
            request_id: requestId,
          },
        },
        502
      );
    }
  });

  // GET /account/billing — current plan + usage snapshot for agents/dashboard
  app.get("/account/billing", async (c) => {
    const scopeError = requireScopes(c, "memory:read");
    if (scopeError) return c.json(scopeError, 403);

    const db = c.get("db");
    const account = c.get("account");
    const requestId = c.get("requestId");

    const [memoryCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmMemories)
      .where(and(eq(wmMemories.accountId, account.id), isNull(wmMemories.supersededBy)));

    const [containerCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(wmAccounts)
      .where(eq(wmAccounts.parentAccountId, account.id));

    const containerLimit =
      PLAN_LIMITS[account.planTier]?.containerLimit ?? CONTAINER_LIMITS[account.planTier] ?? 0;

    return c.json({
      billing: {
        planTier: account.planTier,
        planStatus: account.planStatus,
        currentPeriodEnd: account.currentPeriodEnd?.toISOString() ?? null,
        usage: {
          memoryCount: memoryCountRow?.count ?? 0,
          memoryLimit: account.memoryLimit,
          containerCount: containerCountRow?.count ?? 0,
          containerLimit,
        },
        // URLs are agent affordances. The agent can hit POST checkout/portal
        // itself when it wants a URL — we don't pre-mint here because each
        // call has rate limits and side effects on Stripe.
        actions: {
          checkout: "POST /v1/account/checkout",
          portal: account.stripeCustomerId ? "POST /v1/account/billing-portal" : null,
        },
      },
      request_id: requestId,
    });
  });

  return app;
}
