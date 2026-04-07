import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  real,
  unique,
  index,
  customType,
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

export const wmAccounts = pgTable("wm_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    keyHashIdx: index("wm_api_keys_key_hash_idx").on(table.keyHash),
    accountIdIdx: index("wm_api_keys_account_id_idx").on(table.accountId),
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
    key: text("key"),
    content: text("content").notNull(),
    source: text("source", { enum: ["explicit", "extracted"] }).notNull(),
    importance: real("importance").notNull().default(0.5),
    embedding: vector("embedding", { dimensions: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
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

export type WmMemory = typeof wmMemories.$inferSelect;
export type NewWmMemory = typeof wmMemories.$inferInsert;
