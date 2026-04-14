import { Hono } from "hono";
import type { WorkerEnv, AppVariables } from "../../types";
import { addRoute } from "./add";
import { getRoute } from "./get";
import { recallRoute } from "./recall";
import { removeRoute } from "./remove";
import { healthRoute } from "./health";
import { memoriesRoute } from "./memories";
import { accountRoute } from "./account";
import { containersRoute } from "./containers";

export function v1Routes() {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();
  app.route("/", addRoute());
  app.route("/", getRoute());
  app.route("/", recallRoute());
  app.route("/", removeRoute());
  app.route("/", healthRoute());
  app.route("/", memoriesRoute());
  app.route("/", accountRoute());
  app.route("/", containersRoute());

  // Catch-all for unknown /v1/* routes — returns the standard error envelope
  // so the SDK always gets a parseable { error: { code, message } } response.
  app.all("*", (c) => {
    return c.json(
      { error: { code: "not_found", message: "Route not found", request_id: c.get("requestId") } },
      404
    );
  });

  return app;
}
