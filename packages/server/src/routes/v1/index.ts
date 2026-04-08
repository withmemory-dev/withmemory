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
  //
  // Uses app.all("*") instead of Hono's .notFound() because .notFound() does
  // not fire on sub-apps mounted via app.route() — the parent app's default
  // 404 handler catches the request first. Sub-apps need a catch-all route as
  // their last handler instead. Future sub-apps (e.g. /v2) should follow this
  // pattern.
  app.all("*", (c) => {
    return c.json({ error: { code: "not_found", message: "Route not found" } }, 404);
  });

  return app;
}
