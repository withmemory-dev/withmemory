ALTER TABLE "wm_memories" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "wm_memories" ADD COLUMN "status_error" text;--> statement-breakpoint
CREATE INDEX "wm_memories_account_status_idx" ON "wm_memories" USING btree ("account_id","status");