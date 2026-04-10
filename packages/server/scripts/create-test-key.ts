import { config } from "dotenv";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { wmAccounts, wmApiKeys } from "../src/db/schema";
import { sha256Hex } from "../src/lib/hash";

config({ path: resolve(process.cwd(), ".env.local") });

// ─── Argument parsing ────────────────────────────────────────────────────────
//
// Flags:
//   --email <address>   Email to use as the account identifier. Creates the
//                       account if it doesn't exist, reuses it if it does.
//                       Default: test@withmemory.local
//   --prod              Target the production database via PROD_DIRECT_URL
//                       instead of the local DATABASE_URL. Uses the direct
//                       connection (not the pooler) because account+key
//                       creation is a one-shot administrative operation,
//                       matching the db:migrate:prod convention.
//
// Examples:
//   pnpm db:create-test-key
//   pnpm db:create-test-key -- --email test-b@withmemory.local
//   pnpm db:create-test-key -- --prod --email andrew+prod-test@withmemory.dev

const DEFAULT_EMAIL = "test@withmemory.local";

function parseArgs(argv: string[]): { email: string; useProd: boolean } {
  let email = DEFAULT_EMAIL;
  let useProd = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--prod") {
      useProd = true;
    } else if (arg === "--email") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("ERROR: --email requires a value");
        process.exit(1);
      }
      email = value;
      i++; // skip the value we just consumed
    } else if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length);
      if (!email) {
        console.error("ERROR: --email= requires a value");
        process.exit(1);
      }
    } else {
      console.error(`ERROR: Unknown argument: ${arg}`);
      console.error("Usage: pnpm db:create-test-key [-- --email <address>] [--prod]");
      process.exit(1);
    }
  }

  return { email, useProd };
}

const { email, useProd } = parseArgs(process.argv);

// ─── Database URL selection ──────────────────────────────────────────────────

const databaseUrl = useProd
  ? process.env.PROD_DIRECT_URL
  : process.env.DATABASE_URL;

if (!databaseUrl) {
  if (useProd) {
    console.error(
      "ERROR: PROD_DIRECT_URL is not set. Check packages/server/.env.local."
    );
    console.error(
      "       This should be the direct (port 5432) Supabase connection, not the pooler."
    );
  } else {
    console.error(
      "ERROR: DATABASE_URL is not set. Check packages/server/.env.local."
    );
  }
  process.exit(1);
}

// Safety affordance: print which database the script is about to write to
// BEFORE doing anything destructive. If you run --prod by accident, you see
// this and can Ctrl-C before the insert.
console.log("");
console.log(`  Target:      ${useProd ? "PRODUCTION" : "local dev"}`);
console.log(`  Account email: ${email}`);
console.log("");

async function main() {
  const db = createDb(databaseUrl!);

  try {
    // Find or create account for the provided email
    const existing = await db
      .select()
      .from(wmAccounts)
      .where(eq(wmAccounts.email, email))
      .limit(1);

    let account;
    let accountWasCreated = false;
    if (existing.length > 0) {
      account = existing[0];
    } else {
      const inserted = await db
        .insert(wmAccounts)
        .values({ email })
        .returning();
      account = inserted[0];
      accountWasCreated = true;
    }

    // Generate raw key: wm_test_ + base64url(32 random bytes)
    const rawRandom = randomBytes(32).toString("base64url");
    const rawKey = `wm_test_${rawRandom}`;
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = await sha256Hex(rawKey);

    // Insert new API key row under this account
    const inserted = await db
      .insert(wmApiKeys)
      .values({
        accountId: account.id,
        keyHash,
        keyPrefix,
        name: "test-key",
      })
      .returning();

    const apiKey = inserted[0];

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Test API key created
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Target:      ${useProd ? "PRODUCTION" : "local dev"}
  Account:     ${email} ${accountWasCreated ? "(created)" : "(existing)"}
  Account ID:  ${account.id}
  API Key ID:  ${apiKey.id}
  Key prefix:  ${keyPrefix}

  Plaintext key (SAVE THIS NOW — it will not be shown again):

  ${rawKey}

  Use this key in the Authorization header:
  Authorization: Bearer ${rawKey}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  } catch (error) {
    console.error("ERROR:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  process.exit(0);
}

main();
