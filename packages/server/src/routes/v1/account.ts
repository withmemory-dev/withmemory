import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import type { WorkerEnv, AppVariables } from "../../types";
import { zodErrorHook } from "../../lib/validation";
import { requirePlan, PlanEnforcementError } from "../../lib/plan-enforcement";

const { wmAccounts } = schema;

const SetPromptSchema = z.object({
  prompt: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(32768)),
});

const setPromptValidator = zValidator("json", SetPromptSchema, zodErrorHook);

export function accountRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

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

    return c.json({ prompt, source: "custom" });
  });

  // GET /account/extraction-prompt — read current prompt state
  app.get("/account/extraction-prompt", async (c) => {
    const account = c.get("account");

    if (account.extractionPrompt) {
      return c.json({ prompt: account.extractionPrompt, source: "custom" });
    }

    return c.json({ prompt: null, source: "default" });
  });

  // DELETE /account/extraction-prompt — reset to default
  app.delete("/account/extraction-prompt", async (c) => {
    const db = c.get("db");
    const account = c.get("account");

    await db
      .update(wmAccounts)
      .set({ extractionPrompt: null })
      .where(eq(wmAccounts.id, account.id));

    return c.json({ reset: true });
  });

  return app;
}
