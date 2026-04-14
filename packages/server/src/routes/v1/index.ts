import { Hono } from "hono";
import type { WorkerEnv, AppVariables } from "../../types";
import { setRoute } from "./set";
import { getRoute } from "./get";
import { recallRoute } from "./recall";
import { removeRoute } from "./remove";
import { healthRoute } from "./health";
import { commitRoute } from "./commit";
import { memoriesRoute } from "./memories";
import { accountRoute } from "./account";
import { containersRoute } from "./containers";

export function v1Routes() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
  app.route("/", setRoute());
  app.route("/", getRoute());
  app.route("/", recallRoute());
  app.route("/", removeRoute());
  app.route("/", healthRoute());
  app.route("/", commitRoute());
  app.route("/", memoriesRoute());
  app.route("/", accountRoute());
  app.route("/", containersRoute());

  // Catch-all for unknown /v1/* routes — returns the standard error envelope
  // so the SDK always gets a parseable { error: { code, message } } response.
  app.all("*", (c) => {
    return c.json({ error: { code: "not_found", message: "Route not found" } }, 404);
  });

  return app;
}
