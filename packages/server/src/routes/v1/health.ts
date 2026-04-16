import { Hono } from "hono";
import type { WorkerEnv, AppVariables } from "../../types";

export function healthRoute() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

  app.get("/health", (c) => {
    return c.json({ health: { status: "ok" as const, version: "0.0.0" }, request_id: c.get("requestId") });
  });

  return app;
}
