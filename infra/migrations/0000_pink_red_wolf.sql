CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "wm_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wm_accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "wm_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wm_end_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wm_end_users_account_external_unique" UNIQUE("account_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "wm_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"end_user_id" uuid NOT NULL,
	"key" text,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"embedding" vector(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_recalled_at" timestamp with time zone,
	"superseded_by" uuid,
	CONSTRAINT "wm_memories_account_user_key_unique" UNIQUE("account_id","end_user_id","key")
);
--> statement-breakpoint
ALTER TABLE "wm_api_keys" ADD CONSTRAINT "wm_api_keys_account_id_wm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wm_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wm_end_users" ADD CONSTRAINT "wm_end_users_account_id_wm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wm_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wm_memories" ADD CONSTRAINT "wm_memories_account_id_wm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wm_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wm_memories" ADD CONSTRAINT "wm_memories_end_user_id_wm_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."wm_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wm_api_keys_key_hash_idx" ON "wm_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "wm_api_keys_account_id_idx" ON "wm_api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "wm_memories_account_user_active_idx" ON "wm_memories" USING btree ("account_id","end_user_id");
--> statement-breakpoint
CREATE INDEX "wm_memories_embedding_hnsw_idx" ON "wm_memories" USING hnsw ("embedding" vector_cosine_ops);
