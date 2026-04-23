export interface WithMemoryConfig {
  apiKey: string;
  baseUrl?: string;
  /** Request timeout in milliseconds. Default: 60000 (60 seconds). */
  timeout?: number;
  /** Maximum number of automatic retries on transient failures. Default: 3. */
  maxRetries?: number;
  /** Optional client identifier sent as X-WithMemory-Client header. Format: agent-name/version. */
  clientId?: string;
}

export interface RequestOptions {
  /** Override the client's default timeout for this request (milliseconds). */
  timeout?: number;
  /** Override the client's default max retries for this request. */
  maxRetries?: number;
  /** Abort signal to cancel the request. */
  signal?: AbortSignal;
  /**
   * Idempotency key for this request. When set, the SDK sends it as the
   * `Idempotency-Key` HTTP header. Primarily useful on `add()` so that a
   * retry after a network error doesn't double-create memories.
   */
  idempotencyKey?: string;
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
  /** Importance score (0-1). Only valid on explicit writes (when `key` is provided). Default 0.5. */
  importance?: number;
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

export interface WhoamiResponse {
  account: {
    id: string;
    email: string;
    planTier: string;
    planStatus: string;
    memoryLimit: number;
    monthlyApiCallLimit: number | null;
    createdAt: string;
  };
  key: {
    id: string;
    scopes: string;
    name: string | null;
    createdAt: string;
    expiresAt: string | null;
  };
  request_id?: string;
}

export interface UsageResponse {
  usage: {
    memoryCount: number;
    memoryLimit: number;
    containerCount: number;
    containerLimit: number | null;
  };
  request_id?: string;
}

export interface RecallOptions {
  scope: string;
  query: string;
  maxItems?: number;
  maxTokens?: number;
  defaults?: Record<string, string>;
  /**
   * Similarity threshold preset. Maps on the server to the cosine
   * `similarityFloor`:
   *   - `"strict"`     → 0.4 (fewer, tighter matches)
   *   - `"balanced"`   → 0.2 (default when omitted)
   *   - `"permissive"` → 0.1 (more, looser matches)
   */
  threshold?: "strict" | "balanced" | "permissive";
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

// ─── Cache ──────────────────────────────────────────────────────────────

export interface CacheCreateOptions {
  ttlSeconds?: number;
}

export interface CacheCreateResponse {
  cache: {
    id: string;
    rawToken: string;
    claimToken: string;
    claimUrl: string;
    expiresAt: string;
  };
  request_id?: string;
}

export interface CacheEntry {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface CacheSetResponse {
  entry: CacheEntry;
  request_id?: string;
}

export interface CacheGetResponse {
  entry: CacheEntry | null;
  request_id?: string;
}

export interface CacheDeleteResponse {
  result: { deleted: boolean };
  request_id?: string;
}

export interface CacheListEntry {
  key: string;
  createdAt: string;
  updatedAt: string;
}

export interface CacheListResponse {
  entries: CacheListEntry[];
  request_id?: string;
}

export interface CacheClaimOptions {
  claimToken: string;
}

export interface CacheClaimResponse {
  result: {
    claimed: boolean;
    containerId: string;
    memoriesCreated: number;
    /**
     * Scope string the claiming agent passes to `recall({ scope })` to read
     * the memories that were moved from the cache into the new container.
     * Server-side value is `cache-${cacheId}` — the same string used as the
     * end user's `externalId` inside the claimed container.
     */
    scope: string;
    /**
     * Raw API key, shown once. Scoped `memory:read` against the claimed
     * container and nothing else. The key is not retrievable after this
     * response — if the agent loses it, the only recovery path is
     * `containers.createKey()` from the parent account's Pro+ plan.
     */
    containerKey: string;
  };
  request_id?: string;
}

// ─── Auth (request-code / verify-code) ───────────────────────────────────

export interface RequestCodeParams {
  email: string;
}

export interface RequestCodeResponse {
  result: {
    sent: boolean;
  };
  request_id?: string;
}

export interface VerifyCodeParams {
  email: string;
  code: string;
  /**
   * Optional human-readable label for the key that gets minted. Stored on
   * the API key row and surfaced via `whoami().key.name`. Default when
   * omitted: `"Agent-created key"`.
   */
  issuedTo?: string;
}

export interface VerifyCodeResponse {
  result: {
    apiKey: string;
    accountId: string;
    isNewAccount: boolean;
  };
  request_id?: string;
}
