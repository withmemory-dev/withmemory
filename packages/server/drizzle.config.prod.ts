import { config } from "dotenv";
import type { Config } from "drizzle-kit";

// Load environment variables from .env.local
config({ path: ".env.local" });

if (!process.env.PROD_DIRECT_URL) {
  throw new Error("PROD_DIRECT_URL is not set. Add it to packages/server/.env.local");
}

export default {
  schema: "./src/db/schema.ts",
  out: "../../infra/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.PROD_DIRECT_URL,
  },
  verbose: true,
  strict: true,
} satisfies Config;
