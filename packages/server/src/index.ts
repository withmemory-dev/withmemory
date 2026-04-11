import { Hono } from "hono";
import { createDb } from "./db/client";
import { sql } from "drizzle-orm";
import type { WorkerEnv, AppVariables } from "./types";
import { authMiddleware } from "./middleware/auth";
import { v1Routes } from "./routes/v1";

const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

// /v1/* middleware: create db per-request from Worker bindings, then run auth
app.use("/v1/*", async (c, next) => {
  const db = createDb(c.env.DATABASE_URL);
  c.set("db", db);
  return authMiddleware(db)(c, next);
});

app.route("/v1", v1Routes());

app.get("/", (c) => {
  return c.json({
    name: "withmemory-api",
    version: "0.0.0",
    status: "ok",
    message: "Persistent memory for AI agents.",
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health/db", async (c) => {
  const databaseUrl = c.env.DATABASE_URL;

  if (!databaseUrl) {
    return c.json(
      {
        status: "error",
        message: "DATABASE_URL is not configured",
      },
      500
    );
  }

  try {
    const db = createDb(databaseUrl);

    // Run a trivial query that exercises the connection without depending on any tables
    const result = await db.execute(sql`SELECT 1 AS connected, now() AS server_time`);

    return c.json({
      status: "ok",
      database: "connected",
      server_time: result[0]?.server_time,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("health/db error:", error);
    return c.json(
      {
        status: "error",
        database: "disconnected",
        message: "Database connection failed",
      },
      503
    );
  }
});

export default app;
