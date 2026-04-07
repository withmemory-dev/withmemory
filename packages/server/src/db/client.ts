import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Create a Drizzle database client from a Postgres connection URL.
 *
 * This factory pattern is used because the WithMemory server runs in two
 * environments with different ways of providing the connection URL:
 *
 * 1. Cloudflare Workers (hosted):
 *    The URL comes from `env.DATABASE_URL` (a Worker binding, set via
 *    `wrangler secret put DATABASE_URL` for production or `.dev.vars` for
 *    local Worker dev). Connections are created per-request and discarded
 *    because Workers cannot hold persistent TCP connections.
 *
 * 2. Node.js (future self-host):
 *    The URL comes from `process.env.DATABASE_URL`. Connections can be
 *    reused across requests since Node holds state between invocations.
 *
 * The caller is responsible for providing the URL — this module never
 * touches `process.env` or any runtime-specific globals, which keeps it
 * portable across runtimes.
 */
export function createDb(databaseUrl: string) {
  // Configure postgres-js for serverless / per-request use
  // - max: 1 connection (no pooling on the client side, the server pools)
  // - prepare: false (PgBouncer in transaction mode does not support prepared statements)
  // - idle_timeout: short, since connections are throwaway in Workers
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema });
}

/**
 * Inferred type of the Drizzle client. Use this in route handler signatures
 * when you need to pass the database around.
 */
export type Database = ReturnType<typeof createDb>;
