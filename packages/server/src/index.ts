import { Hono } from "hono";
import { createDb } from "./db/client";
import { sql } from "drizzle-orm";

type Env = {
  DATABASE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();

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
    return c.json(
      {
        status: "error",
        database: "disconnected",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      503
    );
  }
});

export default app;
