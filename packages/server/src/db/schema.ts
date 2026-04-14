import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  unique,
  index,
  check,
  customType,
  jsonb,
} from "drizzle-orm/pg-core";

// pgvector custom type — Drizzle doesn't have native vector support yet,
// so we declare it as a custom type that maps to Postgres `vector(512)`.
// We use 512 dimensions (Matryoshka truncation of text-embedding-3-small)
// for half the storage of full 1536-dim vectors with ~97% of the quality.
const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 512})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .map((n) => Number.parseFloat(n));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// wm_accounts — your customers (developers using WithMemory)
// ─────────────────────────────────────────────────────────────────────────────

export const planTierValues = ["free", "basic", "pro", "team", "enterprise"] as const;
export type PlanTier = (typeof planTierValues)[number];

export const planStatusValues = ["active", "past_due", "canceled", "trialing"] as const;
export type PlanStatus = (typeof planStatusValues)[number];

export const wmAccounts = pgTable(
  "wm_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    extractionPrompt: text("extraction_prompt"),
    planTier: text("plan_tier").$type<PlanTier>().notNull().default("free"),
    planStatus: text("plan_status").$type<PlanStatus>().notNull().default("active"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    memoryLimit: integer("memory_limit").notNull().default(1000),
    // Reserved for future API call rate limiting. Not currently enforced.
    monthlyApiCallLimit: integer("monthly_api_call_limit").notNull().default(10000),
    // Human-readable display name. Required for sub-accounts, optional for
    // top-level accounts (which use email as their primary identifier).
    name: text("name"),
    // Arbitrary metadata JSON. Used by sub-accounts to store purpose, tags,
    // or any context the parent wants to attach. Max 4KB enforced at the route.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    // Self-referencing FK: containers live inside a parent account.
    // NULL = top-level (parent-eligible) account. ON DELETE CASCADE
    // removes all containers when the parent is deleted.
    parentAccountId: uuid("parent_account_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    parentAccountIdIdx: index("wm_accounts_parent_account_id_idx").on(table.parentAccountId),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// wm_api_keys — API keys for authenticating to the WithMemory API
// ─────────────────────────────────────────────────────────────────────────────

export const wmApiKeys = pgTable(
  "wm_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => wmAccounts.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name"),
    // Comma-separated scope string. Default gives existing keys full access.
    scopes: text("scopes").notNull().default("memory:read,memory:write,account:admin"),
    // Nullable = no expiry. Non-null = auth middleware rejects after this time.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Human-readable label for what/who this key was issued for.
    issuedTo: text("issued_to"),
    // Soft revocation: set to NOW() instead of deleting the row.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Self-referencing FK: keys minted via sub-accounts API point to the minting key.
    // ON DELETE SET NULL so revoking a parent key doesn't cascade to sub-account keys.
    parentKeyId: uuid("parent_key_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    keyHashIdx: index("wm_api_keys_key_hash_idx").on(table.keyHash),
    accountIdIdx: index("wm_api_keys_account_id_idx").on(table.accountId),
    expiresAtIdx: index("wm_api_keys_expires_at_idx").on(table.expiresAt),
    parentKeyIdIdx: index("wm_api_keys_parent_key_id_idx").on(table.parentKeyId),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// wm_users — dashboard users, mirrored from auth.users via trigger
// The id column mirrors auth.users(id). Cross-schema FK not expressible in
// Drizzle — enforced via trigger on Supabase, CLI seed on self-hosted.
// ─────────────────────────────────────────────────────────────────────────────

export const wmUsers = pgTable("wm_users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// wm_account_members — join table linking users to accounts
// Roles: 'owner' (full control), 'admin' (manage keys/members), 'member' (read)
// ─────────────────────────────────────────────────────────────────────────────

export const memberRoleValues = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof memberRoleValues)[number];

export const wmAccountMembers = pgTable(
  "wm_account_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => wmAccounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => wmUsers.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    invitedBy: uuid("invited_by").references(() => wmUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueAccountUser: unique().on(table.accountId, table.userId),
    accountIdx: index("wm_account_members_account_idx").on(table.accountId),
    userIdx: index("wm_account_members_user_idx").on(table.userId),
    roleCheck: check("wm_account_members_role_check", sql`role IN ('owner', 'admin', 'member')`),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// wm_end_users — the developers' end users (whose memories are stored)
// ─────────────────────────────────────────────────────────────────────────────

export const wmEndUsers = pgTable(
  "wm_end_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => wmAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueAccountExternal: unique("wm_end_users_account_external_unique").on(
      table.accountId,
      table.externalId
    ),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// wm_exchanges — conversation turns submitted via commit()
// ─────────────────────────────────────────────────────────────────────────────

export const wmExchanges = pgTable(
  "wm_exchanges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => wmAccounts.id, { onDelete: "cascade" }),
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => wmEndUsers.id, { onDelete: "cascade" }),
    input: text("input").notNull(),
    output: text("output").notNull(),
    idempotencyKey: text("idempotency_key"),
    promptVersion: text("prompt_version"),
    extractionStatus: text("extraction_status", {
      enum: ["pending", "completed", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    extractionError: text("extraction_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    extractionCompletedAt: timestamp("extraction_completed_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    // Listing and debugging: exchanges for a user, newest first
    accountUserCreatedIdx: index("wm_exchanges_account_user_created_idx").on(
      table.accountId,
      table.endUserId,
      table.createdAt
    ),
    // Reconciliation jobs filtering by extraction status
    extractionStatusIdx: index("wm_exchanges_extraction_status_idx").on(
      table.extractionStatus
    ),
    // Partial unique index on (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    // — Drizzle cannot declare partial indexes, so this is added manually in the migration SQL
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// wm_memories — the memories themselves (explicit + extracted)
// ─────────────────────────────────────────────────────────────────────────────

export const wmMemories = pgTable(
  "wm_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => wmAccounts.id, { onDelete: "cascade" }),
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => wmEndUsers.id, { onDelete: "cascade" }),
    // NULL key is intentional for extracted memories (source: "extracted").
    // The unique constraint on (account_id, end_user_id, key) treats NULLs as
    // distinct per SQL semantics, so multiple extracted memories per user are allowed.
    key: text("key"),
    content: text("content").notNull(),
    source: text("source", { enum: ["explicit", "extracted"] }).notNull(),
    importance: real("importance").notNull().default(0.5),
    embedding: vector("embedding", { dimensions: 512 }),
    exchangeId: uuid("exchange_id").references(() => wmExchanges.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    // Pipeline state visibility: tracks whether the memory is ready for recall.
    // Explicit set() memories start as 'ready'. Extracted memories from commit()
    // start as 'pending' and transition to 'ready' or 'failed'.
    status: text("status", { enum: ["ready", "pending", "failed"] })
      .notNull()
      .default("ready"),
    statusError: text("status_error"),
  },
  (table) => ({
    // Enforce upsert semantics for explicit set: same (account, user, key) overwrites
    uniqueAccountUserKey: unique("wm_memories_account_user_key_unique").on(
      table.accountId,
      table.endUserId,
      table.key
    ),
    // Hot path: fetching active (non-superseded) memories for a user
    accountUserActiveIdx: index("wm_memories_account_user_active_idx").on(
      table.accountId,
      table.endUserId
    ),
    // Reverse lookup: which memories came from a given exchange
    exchangeIdIdx: index("wm_memories_exchange_id_idx").on(table.exchangeId),
    // Account-wide listing sorted by updated_at (default sort for /v1/memories/list).
    // Postgres can scan this btree backward for DESC ordering.
    accountUpdatedIdx: index("wm_memories_account_updated_idx").on(
      table.accountId,
      table.updatedAt,
      table.id
    ),
    // Recall efficiency: filter to ready memories per account
    accountStatusIdx: index("wm_memories_account_status_idx").on(
      table.accountId,
      table.status
    ),
    // pgvector HNSW index for similarity search — created via raw SQL in migration
    // because Drizzle doesn't generate HNSW index syntax automatically
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Inferred TypeScript types — use these everywhere instead of redefining
// ─────────────────────────────────────────────────────────────────────────────

export type WmAccount = typeof wmAccounts.$inferSelect;
export type NewWmAccount = typeof wmAccounts.$inferInsert;

export type WmApiKey = typeof wmApiKeys.$inferSelect;
export type NewWmApiKey = typeof wmApiKeys.$inferInsert;

export type WmEndUser = typeof wmEndUsers.$inferSelect;
export type NewWmEndUser = typeof wmEndUsers.$inferInsert;

export type WmExchange = typeof wmExchanges.$inferSelect;
export type NewWmExchange = typeof wmExchanges.$inferInsert;

export type WmMemory = typeof wmMemories.$inferSelect;
export type NewWmMemory = typeof wmMemories.$inferInsert;

export type WmUser = typeof wmUsers.$inferSelect;
export type NewWmUser = typeof wmUsers.$inferInsert;

export type WmAccountMember = typeof wmAccountMembers.$inferSelect;
export type NewWmAccountMember = typeof wmAccountMembers.$inferInsert;
