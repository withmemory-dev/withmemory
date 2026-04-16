import { Hono } from "hono";
import { createDb } from "./db/client";
import { sql } from "drizzle-orm";
import type { WorkerEnv, AppVariables } from "./types";
import { authMiddleware } from "./middleware/auth";
import { v1Routes } from "./routes/v1";
import { cacheRoute } from "./routes/v1/cache";
import { authRoute } from "./routes/v1/auth";

const app = new Hono<{ Bindings: WorkerEnv; Variables: AppVariables }>();

// Request ID middleware: generate or forward a request ID on every request
app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  await next();
});

// /v1/* middleware: create db per-request from Worker bindings
app.use("/v1/*", async (c, next) => {
  const db = createDb(c.env.DATABASE_URL);
  c.set("db", db);
  await next();
});

// Auth middleware for all /v1/* except cache routes — cache handles its own auth per-endpoint
app.use("/v1/*", async (c, next) => {
  if (c.req.path.startsWith("/v1/cache") || c.req.path.startsWith("/v1/auth")) {
    return next();
  }
  const db = c.get("db");
  return authMiddleware(db)(c, next);
});

// Unauthenticated routes — cache and auth handle their own auth per-endpoint
app.route("/v1", cacheRoute());
app.route("/v1", authRoute());

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
