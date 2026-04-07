import { Hono } from "hono";

type Env = {
  // Bindings will go here later (DB, secrets, etc.)
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
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
