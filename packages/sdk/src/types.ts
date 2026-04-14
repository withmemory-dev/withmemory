export interface WithMemoryConfig {
  apiKey: string;
  baseUrl?: string;
  /** Request timeout in milliseconds. Default: 60000 (60 seconds). */
  timeout?: number;
  /** Maximum number of automatic retries on transient failures. Default: 3. */
  maxRetries?: number;
}

export interface RequestOptions {
  /** Override the client's default timeout for this request (milliseconds). */
  timeout?: number;
  /** Override the client's default max retries for this request. */
  maxRetries?: number;
  /** Abort signal to cancel the request. */
  signal?: AbortSignal;
}

export interface Memory {
  id: string;
  forScope: string;
  forKey: string | null;
  value: string;
  source: "explicit" | "extracted";
  status: "ready" | "pending" | "failed";
  statusError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddParams {
  forScope: string;
  forKey?: string;
  value: string;
}

export interface AddResponse {
  memories: Memory[];
  request_id?: string;
}

export interface GetParams {
  forScope: string;
  forKey: string;
}

export interface GetResponse {
  memory: Memory | null;
  request_id?: string;
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
  request_id?: string;
}

export interface ExtractionPromptResponse {
  prompt: string | null;
  source: "custom" | "default";
  request_id?: string;
}

export interface ResetExtractionPromptResponse {
  reset: boolean;
  request_id?: string;
}

export interface RemoveResponse {
  deleted: boolean;
  request_id?: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  request_id?: string;
}

export interface RecallOptions {
  forScope: string;
  query: string;
  maxItems?: number;
  maxTokens?: number;
  defaults?: Record<string, string>;
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
  request_id?: string;
}

// ─── Containers ──────────────────────────────────────────────────────────

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
  request_id?: string;
}

export interface CreateContainerKeyResponse {
  key: ContainerKey;
  rawKey: string;
  request_id?: string;
}

export interface ListContainersResponse {
  accounts: Container[];
  total: number;
  request_id?: string;
}

export interface GetContainerOptions {
  forContainer: string;
}

export interface GetContainerResponse {
  account: Container;
  request_id?: string;
}

export interface RevokeContainerKeyOptions {
  forContainer: string;
  forKey: string;
}

export interface RevokeContainerKeyResponse {
  revoked: boolean;
  revokedAt: string;
  request_id?: string;
}

export interface DeleteContainerOptions {
  forContainer: string;
  confirm: true;
}

export interface DeleteContainerResponse {
  deleted: boolean;
  request_id?: string;
}
