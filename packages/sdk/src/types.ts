export interface WithMemoryConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

export interface Memory {
  id: string;
  userId: string;
  key: string | null;
  value: string;
  source: "explicit" | "extracted";
  createdAt: string;
  updatedAt: string;
}

export interface SetResponse {
  memory: Memory;
}

export interface GetResponse {
  memory: Memory | null;
}

export interface RecallResponse {
  context: string;
  memories: Memory[];
  ranking: {
    strategy: "semantic" | "recency_importance" | "user_not_found";
    reason?: "embedding_unavailable";
  };
}

export interface ExtractionPromptResponse {
  prompt: string | null;
  source: "custom" | "default";
}

export interface ResetExtractionPromptResponse {
  reset: boolean;
}

export interface RemoveResponse {
  deleted: boolean;
}

export interface HealthResponse {
  status: "ok";
  version: string;
}

export interface RecallOptions {
  userId: string;
  input: string;
  maxItems?: number;
  maxTokens?: number;
  defaults?: Record<string, string>;
}

export interface CommitOptions {
  userId: string;
  input: string;
  output: string;
}

export interface RegisterDefaults {
  [key: string]: string;
}

export interface FetchMemoriesOptions {
  userId?: string;
  source?: "explicit" | "extracted" | "all";
  search?: string;
  createdAfter?: string;
  createdBefore?: string;
  orderBy?: "updatedAt" | "createdAt" | "importance" | "lastRecalledAt";
  orderDir?: "desc" | "asc";
  limit?: number;
  cursor?: string;
  includeTotal?: boolean;
}

export interface FetchMemoriesResponse {
  memories: Memory[];
  nextCursor: string | null;
  total?: number;
}

// ─── Sub-Accounts ─────────────────────────────────────────────────────────

export interface SubAccount {
  id: string;
  parentAccountId: string;
  name?: string;
  metadata?: Record<string, unknown>;
  planTier?: string;
  memoryLimit?: number;
  memoryCount?: number;
  activeKeyCount?: number;
  createdAt: string;
}

export interface SubAccountKey {
  id: string;
  accountId: string;
  keyPrefix: string;
  scopes: string;
  issuedTo: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateSubAccountOptions {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSubAccountKeyOptions {
  issuedTo: string;
  scopes?: string;
  expiresIn?: number;
}

export interface CreateSubAccountResponse {
  account: SubAccount;
}

export interface CreateSubAccountKeyResponse {
  key: SubAccountKey;
  rawKey: string;
}

export interface ListSubAccountsResponse {
  accounts: SubAccount[];
  total: number;
}

export interface GetSubAccountResponse {
  account: SubAccount;
}

export interface RevokeSubAccountKeyResponse {
  revoked: boolean;
  revokedAt: string;
}

export interface DeleteSubAccountResponse {
  deleted: boolean;
}
