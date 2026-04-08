import { Hono } from "hono";
import type { AppVariables } from "../../types";
import { setRoute } from "./set";
import { recallRoute } from "./recall";

type Env = { DATABASE_URL: string };

export function v1Routes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.route("/", setRoute());
  app.route("/", recallRoute());

  // Catch-all for unknown /v1/* routes — returns the standard error envelope
  // so the SDK always gets a parseable { error: { code, message } } response.
  app.notFound((c) => {
    return c.json({ error: { code: "not_found", message: "Route not found" } }, 404);
  });

  return app;
}
