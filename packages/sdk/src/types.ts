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
  scope: string;
  key: string | null;
  value: string;
  source: "explicit" | "extracted";
  status: "ready" | "pending" | "failed";
  statusError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddParams {
  scope: string;
  key?: string;
  value: string;
}

export interface AddResponse {
  memories: Memory[];
  request_id?: string;
}

export interface GetParams {
  scope: string;
  key: string;
}

export interface GetResponse {
  memory: Memory | null;
  request_id?: string;
}

export interface RemoveParams {
  scope: string;
  key: string;
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
  extractionPrompt: {
    prompt: string | null;
    source: "custom" | "default";
  };
  request_id?: string;
}

export interface ResetExtractionPromptResponse {
  result: {
    reset: boolean;
  };
  request_id?: string;
}

export interface RemoveResponse {
  result: {
    deleted: boolean;
  };
  request_id?: string;
}

export interface HealthResponse {
  health: {
    status: "ok";
    version: string;
  };
  request_id?: string;
}

export interface RecallOptions {
  scope: string;
  query: string;
  maxItems?: number;
  maxTokens?: number;
  defaults?: Record<string, string>;
}

export interface RegisterDefaults {
  [key: string]: string;
}

export interface ListOptions {
  scope?: string;
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
  containerId: string;
  issuedTo: string;
  scopes?: string | string[];
  expiresIn?: number;
}

export interface CreateContainerResponse {
  container: Container;
  request_id?: string;
}

export interface CreateContainerKeyResponse {
  key: ContainerKey;
  rawKey: string;
  request_id?: string;
}

export interface ListContainersResponse {
  containers: Container[];
  total: number;
  request_id?: string;
}

export interface GetContainerOptions {
  containerId: string;
}

export interface GetContainerResponse {
  container: Container;
  request_id?: string;
}

export interface RevokeContainerKeyOptions {
  containerId: string;
  keyId: string;
}

export interface RevokeContainerKeyResponse {
  result: {
    revoked: boolean;
    revokedAt: string;
  };
  request_id?: string;
}

export interface DeleteContainerOptions {
  containerId: string;
  confirm: true;
}

export interface DeleteContainerResponse {
  result: {
    deleted: boolean;
  };
  request_id?: string;
}
