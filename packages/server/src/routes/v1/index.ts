import { Hono } from "hono";
import type { AppVariables } from "../../types";
import { setRoute } from "./set";
import { recallRoute } from "./recall";

type Env = { DATABASE_URL: string };

export function v1Routes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.route("/", setRoute());
  app.route("/", recallRoute());
  return app;
}
