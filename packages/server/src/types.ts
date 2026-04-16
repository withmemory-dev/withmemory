import type { WmAccount, WmApiKey, WmCache } from "./db/schema";
import type { Database } from "./db/client";

export type WorkerEnv = {
  DATABASE_URL: string;
  OPENAI_API_KEY: string;
  EXTRACTION_PROMPT_VERSION: string;
  EXTRACTION_MAX_INPUT_BYTES: string;
  RESEND_API_KEY: string;
};

export type AppVariables = {
  db: Database;
  account: WmAccount;
  apiKey: WmApiKey;
  requestId: string;
  clientId: string | null;
  cache: WmCache;
};
