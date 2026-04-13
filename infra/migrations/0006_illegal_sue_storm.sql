ALTER TABLE "wm_accounts" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "parent_account_id" uuid;--> statement-breakpoint
ALTER TABLE "wm_api_keys" ADD COLUMN "scopes" text DEFAULT 'memory:read,memory:write,account:admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "wm_api_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wm_api_keys" ADD COLUMN "issued_to" text;--> statement-breakpoint
ALTER TABLE "wm_api_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wm_api_keys" ADD COLUMN "parent_key_id" uuid;--> statement-breakpoint

-- Self-referencing FK: sub-accounts → parent account. CASCADE so deleting a
-- parent removes all its sub-accounts (orphaned sub-accounts are worse).
ALTER TABLE "wm_accounts"
  ADD CONSTRAINT "wm_accounts_parent_account_id_fk"
  FOREIGN KEY ("parent_account_id") REFERENCES "wm_accounts"("id")
  ON DELETE CASCADE;--> statement-breakpoint

-- Self-referencing FK: agent-minted keys → the key that created them.
-- SET NULL so revoking a parent key doesn't cascade-revoke sub-account keys.
ALTER TABLE "wm_api_keys"
  ADD CONSTRAINT "wm_api_keys_parent_key_id_fk"
  FOREIGN KEY ("parent_key_id") REFERENCES "wm_api_keys"("id")
  ON DELETE SET NULL;--> statement-breakpoint

-- Partial indexes: only index non-null values since most rows will be NULL
CREATE INDEX "wm_accounts_parent_account_id_idx" ON "wm_accounts" USING btree ("parent_account_id") WHERE "parent_account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wm_api_keys_expires_at_idx" ON "wm_api_keys" USING btree ("expires_at") WHERE "expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wm_api_keys_parent_key_id_idx" ON "wm_api_keys" USING btree ("parent_key_id") WHERE "parent_key_id" IS NOT NULL;
