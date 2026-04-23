import { Hono } from "hono";
import type { WorkerEnv, AppVariables } from "../../types";
import { requireScopes } from "../../lib/scopes";

export function healthRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.get("/health", (c) => {
    const scopeError = requireScopes(c, "memory:read");
    if (scopeError) return c.json(scopeError, 403);

    return c.json({ health: { status: "ok" as const, version: "0.0.0" }, request_id: c.get("requestId") });
  });

  return app;
}
