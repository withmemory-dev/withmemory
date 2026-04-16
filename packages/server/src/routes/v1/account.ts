import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and, isNull, sql } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { zodErrorHook } from "../../lib/validation";
import { requirePlan, PlanEnforcementError } from "../../lib/plan-enforcement";

const { wmAccounts, wmMemories } = schema;

const CONTAINER_LIMITS: Record<string, number | null> = {
  free: 0,
  basic: 0,
  pro: 10,
  team: 100,
  enterprise: null, // unlimited
};

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
    const db = c.get("db");
    const account = c.get("account");

    await db
      .update(wmAccounts)
      .set({ extractionPrompt: null })
      .where(eq(wmAccounts.id, account.id));

    return c.json({ result: { reset: true }, request_id: c.get("requestId") });
  });

  return app;
}
