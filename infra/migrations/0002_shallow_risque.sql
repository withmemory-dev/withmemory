CREATE TABLE "wm_exchanges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"end_user_id" uuid NOT NULL,
	"input" text NOT NULL,
	"output" text NOT NULL,
	"idempotency_key" text,
	"prompt_version" text,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"extraction_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extraction_completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wm_memories" ADD COLUMN "exchange_id" uuid;--> statement-breakpoint
ALTER TABLE "wm_exchanges" ADD CONSTRAINT "wm_exchanges_account_id_wm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wm_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wm_exchanges" ADD CONSTRAINT "wm_exchanges_end_user_id_wm_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."wm_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wm_exchanges_account_user_created_idx" ON "wm_exchanges" USING btree ("account_id","end_user_id","created_at");--> statement-breakpoint
CREATE INDEX "wm_exchanges_extraction_status_idx" ON "wm_exchanges" USING btree ("extraction_status");--> statement-breakpoint
ALTER TABLE "wm_memories" ADD CONSTRAINT "wm_memories_exchange_id_wm_exchanges_id_fk" FOREIGN KEY ("exchange_id") REFERENCES "public"."wm_exchanges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wm_memories_exchange_id_idx" ON "wm_memories" USING btree ("exchange_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "wm_exchanges_idempotency_key_unique_idx" ON "wm_exchanges" ("account_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;