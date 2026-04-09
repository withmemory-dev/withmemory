import type { WmAccount, WmApiKey } from "./db/schema";
import type { Database } from "./db/client";

export type WorkerEnv = {
  DATABASE_URL: string;
};

export type AppVariables = {
  db: Database;
  account: WmAccount;
  apiKey: WmApiKey;
};
