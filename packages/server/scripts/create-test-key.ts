import { config } from "dotenv";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { wmAccounts, wmApiKeys } from "../src/db/schema";
import { sha256Hex } from "../src/lib/hash";

config({ path: resolve(process.cwd(), ".env.local") });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set. Check packages/server/.env.local");
  process.exit(1);
}

const TEST_EMAIL = "test@withmemory.local";

async function main() {
  const db = createDb(DATABASE_URL!);

  try {
    // Find or create test account
    const existing = await db
      .select()
      .from(wmAccounts)
      .where(eq(wmAccounts.email, TEST_EMAIL))
      .limit(1);

    let account;
    if (existing.length > 0) {
      account = existing[0];
    } else {
      const inserted = await db
        .insert(wmAccounts)
        .values({ email: TEST_EMAIL })
        .returning();
      account = inserted[0];
    }

    // Generate raw key: wm_test_ + base64url(32 random bytes)
    const rawRandom = randomBytes(32).toString("base64url");
    const rawKey = `wm_test_${rawRandom}`;
    const keyPrefix = rawKey.slice(0, 11);
    const keyHash = await sha256Hex(rawKey);

    // Insert new API key row
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
