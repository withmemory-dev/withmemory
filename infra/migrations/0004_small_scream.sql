CREATE TABLE "wm_account_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wm_account_members_account_id_user_id_unique" UNIQUE("account_id","user_id"),
	CONSTRAINT "wm_account_members_role_check" CHECK (role IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "wm_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wm_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "plan_tier" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "plan_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "memory_limit" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wm_accounts" ADD COLUMN "monthly_api_call_limit" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wm_account_members" ADD CONSTRAINT "wm_account_members_account_id_wm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wm_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wm_account_members" ADD CONSTRAINT "wm_account_members_user_id_wm_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."wm_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wm_account_members" ADD CONSTRAINT "wm_account_members_invited_by_wm_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."wm_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wm_account_members_account_idx" ON "wm_account_members" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "wm_account_members_user_idx" ON "wm_account_members" USING btree ("user_id");--> statement-breakpoint
COMMENT ON COLUMN "wm_accounts"."monthly_api_call_limit" IS 'Column exists for Session 12 Stripe integration. Not enforced as of Session 10.';