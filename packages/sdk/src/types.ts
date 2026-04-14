export interface WithMemoryConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

export interface Memory {
  id: string;
  forScope: string;
  forKey: string | null;
  value: string;
  source: "explicit" | "extracted";
  createdAt: string;
  updatedAt: string;
}

export interface SetParams {
  forScope: string;
  forKey: string;
  value: string;
}

export interface SetResponse {
  memory: Memory;
}

export interface GetParams {
  forScope: string;
  forKey: string;
}

export interface GetResponse {
  memory: Memory | null;
}

export interface RemoveParams {
  forScope: string;
  forKey: string;
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
  forScope: string;
  query: string;
  maxItems?: number;
  maxTokens?: number;
  defaults?: Record<string, string>;
}

export interface CommitOptions {
  forScope: string;
  input: string;
  output: string;
}

export interface RegisterDefaults {
  [key: string]: string;
}

export interface ListOptions {
  forScope?: string;
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

export interface ListResponse {
  memories: Memory[];
  nextCursor: string | null;
  total?: number;
}

// ─── Backward compat aliases ─────────────────────────────────────────────

/** @deprecated Use ListOptions instead */
export type FetchMemoriesOptions = ListOptions;
/** @deprecated Use ListResponse instead */
export type FetchMemoriesResponse = ListResponse;

// ─── Containers (formerly Sub-Accounts) ──────────────────────────────────

export interface Container {
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

export interface ContainerKey {
  id: string;
  accountId: string;
  keyPrefix: string;
  scopes: string;
  issuedTo: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateContainerOptions {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface CreateContainerKeyOptions {
  forContainer: string;
  issuedTo: string;
  scopes?: string;
  expiresIn?: number;
}

export interface CreateContainerResponse {
  account: Container;
}

export interface CreateContainerKeyResponse {
  key: ContainerKey;
  rawKey: string;
}

export interface ListContainersResponse {
  accounts: Container[];
  total: number;
}

export interface GetContainerOptions {
  forContainer: string;
}

export interface GetContainerResponse {
  account: Container;
}

export interface RevokeContainerKeyOptions {
  forContainer: string;
  forKey: string;
}

export interface RevokeContainerKeyResponse {
  revoked: boolean;
  revokedAt: string;
}

export interface DeleteContainerOptions {
  forContainer: string;
  confirm: true;
}

export interface DeleteContainerResponse {
  deleted: boolean;
}

// ─── Backward compat aliases (sub-accounts → containers) ─────────────────

/** @deprecated Use Container instead */
export type SubAccount = Container;
/** @deprecated Use ContainerKey instead */
export type SubAccountKey = ContainerKey;
/** @deprecated Use CreateContainerOptions instead */
export type CreateSubAccountOptions = CreateContainerOptions;
/** @deprecated Use CreateContainerKeyOptions instead */
export type CreateSubAccountKeyOptions = CreateContainerKeyOptions;
/** @deprecated Use CreateContainerResponse instead */
export type CreateSubAccountResponse = CreateContainerResponse;
/** @deprecated Use CreateContainerKeyResponse instead */
export type CreateSubAccountKeyResponse = CreateContainerKeyResponse;
/** @deprecated Use ListContainersResponse instead */
export type ListSubAccountsResponse = ListContainersResponse;
/** @deprecated Use GetContainerResponse instead */
export type GetSubAccountResponse = GetContainerResponse;
/** @deprecated Use RevokeContainerKeyResponse instead */
export type RevokeSubAccountKeyResponse = RevokeContainerKeyResponse;
/** @deprecated Use DeleteContainerResponse instead */
export type DeleteSubAccountResponse = DeleteContainerResponse;
