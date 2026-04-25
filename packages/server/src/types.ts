import type { WmAccount, WmApiKey, WmCache } from "./db/schema";
import type { Database } from "./db/client";

export type WorkerEnv = {
  DATABASE_URL: string;
  OPENAI_API_KEY: string;
  EXTRACTION_PROMPT_VERSION: string;
  EXTRACTION_MAX_INPUT_BYTES: string;
  RESEND_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_BASIC: string;
  STRIPE_PRICE_PRO: string;
  // Public-facing dashboard origin used for Checkout success/cancel + Billing
  // Portal return URLs. Optional in env — defaults to https://app.withmemory.dev
  // when unset so prod works without an extra secret being plumbed through.
  DASHBOARD_URL?: string;
};

export type AppVariables = {
  db: Database;
  account: WmAccount;
  apiKey: WmApiKey;
  requestId: string;
  clientId: string | null;
  cache: WmCache;
};
