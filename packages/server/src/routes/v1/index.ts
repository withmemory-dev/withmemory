import { Hono } from "hono";
import type { AppVariables } from "../../types";
import { setRoute } from "./set";

type Env = { DATABASE_URL: string };

export function v1Routes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.route("/", setRoute());
  return app;
}
