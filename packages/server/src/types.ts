import type { WmAccount, WmApiKey } from "./db/schema";

export type AppVariables = {
  account: WmAccount;
  apiKey: WmApiKey;
};
