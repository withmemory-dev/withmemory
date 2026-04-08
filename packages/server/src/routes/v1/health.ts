import { Hono } from "hono";
import type { AppVariables } from "../../types";

type Env = { DATABASE_URL: string };

export function healthRoute() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.get("/health", (c) => {
    return c.json({ status: "ok" as const, version: "0.0.0" });
  });

  return app;
}
