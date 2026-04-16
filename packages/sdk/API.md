# @withmemory/sdk — API Contract Reference

This file is the canonical in-repo reference for the SDK's public surface. It documents the types, error codes, and response shapes that the SDK and server must agree on. When the SDK types and this file disagree, this file wins.

## Quick start

```ts
import { memory } from "@withmemory/sdk";

memory.configure({ apiKey: "wm_..." });

await memory.add({
  value: "Andrew",
  key: "name",
  scope: "user_alice"
});

const { context } = await memory.recall({
  scope: "user_alice",
  query: "What's the user's name?"
});

// context → "name: Andrew"
```

For multi-tenant apps, use `createClient()`:

```ts
import { createClient } from "@withmemory/sdk";
const client = createClient({ apiKey: "wm_..." });
```

## Changelog

Initial public API.

## Route conventions

All `/v1/*` routes are POST with JSON bodies, except DELETE on resources addressed by primary key (e.g., `DELETE /v1/memories/:id`) and GET for read-only status endpoints (e.g., `GET /v1/health`). The `scope` field is a filter within the account's data, not an addressable resource — it lives in the request body, never in the URL path or query string.

All request bodies are validated with strict Zod schemas. Unrecognized keys are rejected with a 400 `invalid_request` error.

## Authentication models

The API uses three authentication models depending on the endpoint:

| Model | Header | Endpoints |
|-------|--------|-----------|
| **API key auth** | `Authorization: Bearer wm_live_...` | All `/v1/memories/*`, `/v1/recall`, `/v1/account/*`, `/v1/containers/*`, `/v1/cache/claim` |
| **Cache token auth** | `Authorization: Bearer wm_tmp_...` | `/v1/cache/set`, `/v1/cache/get`, `/v1/cache/delete`, `/v1/cache/list` |
| **Unauthenticated** | None | `/v1/cache` (create), `/v1/cache/preview`, `/v1/auth/*`, `/health`, `/health/db` |

Cache tokens are returned by `POST /v1/cache` and are short-lived (24h max). They are separate from API keys and cannot access memory endpoints.

## Error handling

### WithMemoryError

All SDK errors are instances of `WithMemoryError`, which extends `Error`:

```ts
class WithMemoryError extends Error {
  readonly status: number;     // HTTP status code (0 for network/timeout errors)
  readonly code: string;       // Machine-readable error code (see table below)
  readonly details?: unknown;  // Optional structured details (e.g., Zod validation issues)
  readonly requestId?: string; // Server-assigned request ID for debugging
}
```

Every error response from the server includes a `request_id` field in the error envelope and an `X-Request-Id` response header. The SDK populates `WithMemoryError.requestId` from these values.

### Typed error subclasses

Each error code maps to a named subclass. Both patterns work:

```ts
import { WithMemoryError, UnauthorizedError } from '@withmemory/sdk';

try {
  await memory.add({ scope: 'alice', value: '...' });
} catch (err) {
  // Pattern 1: direct import
  if (err instanceof UnauthorizedError) { /* ... */ }

  // Pattern 2: static property
  if (err instanceof WithMemoryError.UnauthorizedError) { /* ... */ }

  // Pattern 3: code check (still works)
  if (err instanceof WithMemoryError && err.code === 'unauthorized') { /* ... */ }
}
```

| Subclass | Code |
|----------|------|
| `UnauthorizedError` | `unauthorized` |
| `KeyExpiredError` | `key_expired` |
| `InvalidRequestError` | `invalid_request` |
| `NotFoundError` | `not_found` |
| `QuotaExceededError` | `quota_exceeded` |
| `PlanRequiredError` | `plan_required` |
| `ContainerLimitExceededError` | `container_limit_exceeded` |
| `ContainerNameExistsError` | `container_name_exists` |
| `ConfirmationRequiredError` | `confirmation_required` |
| `ExtractionFailedError` | `extraction_failed` |
| `RateLimitedError` | `rate_limited` |
| `CacheEntryLimitError` | `cache_entry_limit` |
| `CacheExpiredError` | `cache_expired` |
| `AlreadyClaimedError` | `already_claimed` |
| `TimeoutError` | `timeout` |
| `NetworkError` | `network_error` |

### Error codes

| Code | Origin | HTTP Status | When |
|------|--------|-------------|------|
| `unauthorized` | Server | 401 | Missing, malformed, or invalid API key / cache token |
| `key_expired` | Server | 401 | API key has passed its `expires_at` timestamp |
| `invalid_request` | Server | 400 | Request body fails Zod validation |
| `not_found` | Server | 404 | Route does not exist or resource not found |
| `quota_exceeded` | Server | 403 | Account memory limit reached (summed across parent + containers) |
| `plan_required` | Server | 403 | Feature requires a higher plan tier |
| `container_limit_exceeded` | Server | 403 | Account has reached its container cap |
| `container_name_exists` | Server | 409 | A container with this name already exists under the parent account |
| `confirmation_required` | Server | 400 | Destructive action requires `{ confirm: true }` in body |
| `extraction_failed` | Server | 500 | LLM extraction pipeline failed (extraction path only) |
| `rate_limited` | Server | 429 | Cache creation (3/IP/24h) or auth code request (3/email/hour) rate limit |
| `cache_entry_limit` | Server | 403 | Cache entry cap reached (50 entries per cache) |
| `cache_expired` | Server | 410 | Attempted to claim an expired cache |
| `already_claimed` | Server | 409 | Cache has already been claimed by another account |
| `invalid_code` | Server | 401 | Email verification code is wrong or expired |
| `timeout` | SDK | 0 | Request exceeded the configured timeout |
| `network_error` | SDK | 0 | Fetch failed (DNS, connection refused, TLS, offline, etc.) |

### Enriched error details

`quota_exceeded` and `container_limit_exceeded` errors include actionable recovery information in `details`:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "Memory limit reached (100 / 100).",
    "details": {
      "current": 100,
      "limit": 100,
      "plan_tier": "pro",
      "quota_scope": "parent_account",
      "recovery_options": [
        { "action": "remove_memories", "description": "Remove old memories with memory.list() + memory.remove() or memory.delete()" },
        { "action": "supersede_duplicates", "description": "Dedup by re-adding with the same key" },
        { "action": "upgrade_plan", "url": "https://app.withmemory.dev/settings/billing", "description": "Upgrade your plan for a higher memory limit" }
      ]
    }
  }
}
```

`container_limit_exceeded` follows the same pattern with `delete_containers` and `upgrade_plan` recovery options.

`quota_scope` is `"parent_account"` for top-level accounts or `"container"` for sub-accounts. Read endpoints (`list`, `get`, `recall`) are never blocked by quota — only writes (`add`) are gated, so the "list + remove" recovery path always works.

### Auto-retry

The SDK automatically retries transient failures with exponential backoff and jitter. Retryable conditions:

- **HTTP status codes:** 408, 409, 429, 500, 502, 503, 504
- **Network errors:** DNS failure, connection refused, timeout

Non-retryable status codes (400, 401, 403, 404) are never retried.

The `Retry-After` header is respected on 429 and 503 responses.

**Configuration:**

```ts
// Client-level default (applies to all requests)
const client = createClient({ apiKey: 'wm_...', maxRetries: 5 });

// Per-request override
await memory.add({ scope: 'alice', value: '...' }, { maxRetries: 0 });
```

Default: 3 retries. Set `maxRetries: 0` to disable retries for a specific call.

**Extraction retry cost:** The extraction path (`add` without `key`) makes an LLM call per attempt. Consider `{ maxRetries: 0 }` or `{ maxRetries: 1 }` for cost-sensitive extraction calls.

### Timeouts

Default timeout: 60 seconds. Configurable at the client level and per-request:

```ts
const client = createClient({ apiKey: 'wm_...', timeout: 30000 });
await memory.add({ scope: 'alice', value: '...' }, { timeout: 10000 });
```

Each retry attempt gets its own fresh timeout. A timeout on one attempt does not consume all retries.

### Idempotency

| Method | Idempotent? | Notes |
|--------|-------------|-------|
| `add({ scope, key, value })` | Yes | Upsert by (scope, key) — same key overwrites |
| `add({ scope, value })` | No | Each call re-runs LLM extraction. Use `Idempotency-Key` header for safe retries |
| `remove({ scope, key })` | Yes | Deleting a nonexistent key returns `{ deleted: false }` |
| `delete(memoryId)` | Yes | Deleting a nonexistent ID returns `{ deleted: false }` |
| `containers.create({ name })` | Idempotent-feeling | Duplicate name returns 409 with `details.existing_container_id` |
| `cache.set({ key, value })` | Yes | Upsert by (cache, key) |

### Health endpoints

Three health endpoints serve different purposes:

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | No | Is the service reachable and responding? |
| `GET /health/db` | No | Can the service reach its database? |
| `GET /v1/health` | Yes | Is the service up AND is my API key valid? |

### Request IDs

Every API response — both successful and error — includes a `request_id` field in the response body. The same value is also returned in the `X-Request-Id` response header. Use this ID when reporting bugs or when correlating client-side logs with server-side traces.

You can pass your own `X-Request-Id` header in the request to thread a tracing ID through the API. If you do, the same value will be returned in both the response body and the response header.

On errors, `request_id` appears inside the `error` envelope. On success, it appears as a top-level sibling of the response data.

### Client attribution

The SDK sends an optional `X-WithMemory-Client` header on every request when `clientId` is set in the config. The recommended format is `agent-name/version` (e.g., `listing-ai/1.0`, `cursor/0.45`).

```ts
const client = createClient({ apiKey: 'wm_...', clientId: 'my-agent/1.0' });
```

The header is purely observational — the server logs it but does not enforce or validate it. It helps WithMemory debug reliability issues and enables future per-agent usage dashboards.

## Types

### Memory

The canonical memory object returned by `add`, `get`, `recall`, and list operations:

```ts
interface Memory {
  id: string;
  scope: string;
  key: string | null;    // null for extracted memories (source: "extracted")
  value: string;           // the memory content — named "value" in the SDK, "content" in the DB
  source: "explicit" | "extracted";
  status: "ready" | "pending" | "failed";
  statusError: string | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
```

### AddResponse

```ts
interface AddResponse {
  memories: Memory[];
  request_id?: string;
}
```

Explicit mode (`key` provided) always returns an array of length 1. Extraction mode (`key` omitted) may return 0, 1, or several memories depending on what the extraction identifies.

### RecallResponse

```ts
interface RecallResponse {
  context: string;         // Always a string, never null. Empty string if no memories.
  memories: Memory[];      // The memories that contributed to the context (status: "ready" only).
  ranking: {
    strategy: "semantic" | "recency_importance" | "user_not_found";
    reason?: "embedding_unavailable";
  };
  request_id?: string;
}
```

The `ranking` field describes how the returned memories were ordered:

- **`"semantic"`** — memories were ranked by cosine similarity against an embedding of the query, combined with recency decay, importance, and source tier.
- **`"recency_importance"`** — the query embedding could not be generated, so memories were ranked by recency and importance only. The `reason` field is `"embedding_unavailable"`.
- **`"user_not_found"`** — the requested `scope` does not exist under the authenticated account. The `memories` array is empty. The `context` may still contain registered defaults.

### GetResponse / RemoveResponse / HealthResponse

```ts
interface GetResponse { memory: Memory | null; request_id?: string; }
interface RemoveResponse { result: { deleted: boolean }; request_id?: string; }
interface HealthResponse { health: { status: "ok"; version: string }; request_id?: string; }
```

### ListOptions / ListResponse

```ts
interface ListOptions {
  scope?: string;            // Filter by scope. Omit for account-wide listing.
  source?: "explicit" | "extracted" | "all";
  search?: string;           // Case-insensitive substring match (1-500 chars)
  createdAfter?: string;     // ISO 8601
  createdBefore?: string;    // ISO 8601
  orderBy?: "updatedAt" | "createdAt" | "importance" | "lastRecalledAt";
  orderDir?: "desc" | "asc";
  limit?: number;            // 1-200, default 50
  cursor?: string;
  includeTotal?: boolean;
}

interface ListResponse {
  memories: Memory[];
  nextCursor: string | null;
  total?: number;
  request_id?: string;
}
```

### WhoamiResponse / UsageResponse

```ts
interface WhoamiResponse {
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
    scopes: string;           // e.g. "memory:read,memory:write,account:admin"
    name: string | null;
    createdAt: string;
    expiresAt: string | null;
  };
  request_id?: string;
}

interface UsageResponse {
  usage: {
    memoryCount: number;
    memoryLimit: number;
    containerCount: number;
    containerLimit: number | null;  // null = unlimited (enterprise)
  };
  request_id?: string;
}
```

`whoami()` lets an agent discover its own key scopes, plan tier, and account metadata without trial-and-error. `usage()` returns current quota consumption so agents can check before hitting limits.

### ExtractionPromptResponse / ResetExtractionPromptResponse

```ts
interface ExtractionPromptResponse {
  extractionPrompt: {
    prompt: string | null;
    source: "custom" | "default";
  };
  request_id?: string;
}

interface ResetExtractionPromptResponse {
  result: {
    reset: boolean;
  };
  request_id?: string;
}
```

## SDK methods

| Method | HTTP | Returns | Throws on error? |
|--------|------|---------|-------------------|
| `configure(config)` | — | `void` | Yes |
| `register(defaults)` | — | `void` | Yes |
| `add({ scope, key?, value })` | `POST /v1/memories` | `AddResponse` | Yes |
| `get({ scope, key })` | `POST /v1/memories/get` | `GetResponse` | Yes |
| `recall({ scope, query, ... })` | `POST /v1/recall` | `RecallResponse` | Yes |
| `remove({ scope, key })` | `POST /v1/memories/remove` | `RemoveResponse` | Yes |
| `list(options?)` | `POST /v1/memories/list` | `ListResponse` | Yes |
| `delete(memoryId)` | `DELETE /v1/memories/:id` | `RemoveResponse` | Yes |
| `health()` | `GET /v1/health` | `HealthResponse` | Yes |
| `whoami()` | `GET /v1/account` | `WhoamiResponse` | Yes |
| `usage()` | `GET /v1/account/usage` | `UsageResponse` | Yes |
| `setExtractionPrompt(prompt)` | `POST /v1/account/extraction-prompt` | `ExtractionPromptResponse` | Yes |
| `getExtractionPrompt()` | `GET /v1/account/extraction-prompt` | `ExtractionPromptResponse` | Yes |
| `resetExtractionPrompt()` | `DELETE /v1/account/extraction-prompt` | `ResetExtractionPromptResponse` | Yes |
| `cache.create(options?)` | `POST /v1/cache` | `CacheInstance` | Yes |
| `cache.claim({ claimToken })` | `POST /v1/cache/claim` | `CacheClaimResponse` | Yes |

### memory.add

`memory.add` is the primary method for storing memories. It has two modes based on whether `key` is provided:

**Explicit mode — direct write:**
```ts
await memory.add({ scope: "alice", key: "name", value: "Andrew" });
```
Writes the value directly under the given key. No LLM call. Returns the written memory in a single-element array.

**Extraction mode — LLM-derived facts:**
```ts
await memory.add({ scope: "alice", value: "The user's name is Andrew and they prefer dark mode" });
```
Runs LLM extraction on the value and stores any facts the extraction identifies. The method is synchronous — it waits for extraction and embedding to complete before returning. Returns all extracted memories (may be zero if extraction identifies no durable facts).

Both modes return the same response shape: `{ memories: Memory[] }`. Explicit mode always returns an array of length 1. Extraction mode may return 0, 1, or several memories depending on what the extraction identifies.

The extraction path respects the account's custom extraction prompt if one is set via `memory.setExtractionPrompt()`.

**`register(defaults)`** stores defaults on the client instance. Defaults are forwarded in the `recall()` request body as a `defaults` field and appear in the `context` as tier 4 fallback (after explicit, extracted, and summary memories). Defaults do NOT appear in the `memories` array — they are prompt-block-only.

**`recall()` accepts optional `defaults`** — a `Record<string, string>` of key-value pairs to include in the context when real memories don't fill the budget. Per-call defaults merge with (and override) any defaults set via `register()`. Only memories with `status: "ready"` are returned.

**`list(options?)`** lists non-superseded memories with optional filtering, search, sort, and cursor-based pagination. Supports account-wide listing (omit `scope`) or per-scope listing (provide `scope`). Cursors are opaque strings using keyset pagination internally.

## Cache

The cache is an ephemeral key-value store for zero-auth bootstrap demos. No API key required to create or use a cache. Caches expire after a configurable TTL (default 24 hours, max 24 hours). Rate limited to 3 caches per IP per 24 hours.

### SDK usage

```ts
const cache = await memory.cache.create();

await cache.set({ key: "user:name", value: "Alice" });
const { entry } = await cache.get({ key: "user:name" });
const { entries } = await cache.list();
await cache.delete({ key: "user:name" });

// Share cache.claimUrl to promote entries into permanent memory
```

`cache.create()` works **without calling `configure()` first** — it is the one method that does not require an API key. The returned `CacheInstance` has bound `set`, `get`, `delete`, and `list` methods authenticated with the cache's own token.

### Cache claim

Claiming promotes all cache entries into permanent memories under a new container in the claimant's account. Requires API key auth.

```ts
const result = await memory.cache.claim({ claimToken: cache.claimToken });
// result: { claimed: true, containerId: "...", memoriesCreated: 5 }
```

### Cache HTTP endpoints

| Endpoint | Auth | Method | Description |
|----------|------|--------|-------------|
| `POST /v1/cache` | None | Create cache | Returns `rawToken`, `claimToken`, `claimUrl`, `expiresAt` |
| `POST /v1/cache/set` | Cache token | Set entry | Upsert by key. 50 entries max, 10KB per value |
| `POST /v1/cache/get` | Cache token | Get entry | Returns entry or null |
| `POST /v1/cache/delete` | Cache token | Delete entry | Returns `{ deleted: boolean }` |
| `GET /v1/cache/list` | Cache token | List entries | Returns keys + timestamps (no values) |
| `POST /v1/cache/claim` | API key | Claim cache | Promotes entries to permanent memories |
| `POST /v1/cache/preview` | None | Preview cache | Returns entry keys (no values) for claim page UI |

### Cache types

```ts
interface CacheCreateOptions { ttlSeconds?: number; }  // 60-86400, default 86400

interface CacheEntry {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

interface CacheSetResponse { entry: CacheEntry; request_id?: string; }
interface CacheGetResponse { entry: CacheEntry | null; request_id?: string; }
interface CacheDeleteResponse { result: { deleted: boolean }; request_id?: string; }

interface CacheListEntry { key: string; createdAt: string; updatedAt: string; }
interface CacheListResponse { entries: CacheListEntry[]; request_id?: string; }

interface CacheClaimResponse {
  result: { claimed: boolean; containerId: string; memoriesCreated: number };
  request_id?: string;
}
```

## Email-code signup

Agents can get API keys without a browser via email verification. Both endpoints are unauthenticated.

### POST /v1/auth/request-code

Sends a 6-digit verification code to the given email. Rate limited to 3 requests per email per hour. Codes expire in 10 minutes.

```json
// Request
{ "email": "user@example.com" }

// Response (200 — always, regardless of whether the email exists)
{ "result": { "sent": true }, "request_id": "..." }
```

### POST /v1/auth/verify-code

Verifies a code and returns a fresh API key. Creates a new account if the email is not registered. Locks after 5 failed attempts (30-minute lockout).

```json
// Request
{ "email": "user@example.com", "code": "847293" }

// Response (200)
{
  "result": {
    "apiKey": "wm_live_...",
    "accountId": "...",
    "isNewAccount": true
  },
  "request_id": "..."
}
```

## Containers

Containers allow Pro-and-up accounts to provision isolated namespaces for autonomous agents. Each container has its own memories, keys, and end users, but quota is inherited from the parent account.

All container management endpoints require an API key with `account:admin` scope on a non-container account. Container keys cannot access container management endpoints.

### Container limits per plan tier

| Plan | Container limit |
|------|-----------------|
| Pro | 10 |
| Team | 100 |
| Enterprise | Unlimited |

### Container SDK methods

All methods are namespaced under `containers`:

| Method | HTTP | Returns | Throws on error? |
|--------|------|---------|-------------------|
| `containers.create({ name, metadata? })` | `POST /v1/containers` | `Container` | Yes |
| `containers.createKey({ containerId, issuedTo, scopes?, expiresIn? })` | `POST /v1/containers/:id/keys` | `CreateContainerKeyResponse` | Yes |
| `containers.list()` | `GET /v1/containers` | `Container[]` | Yes |
| `containers.get({ containerId })` | `GET /v1/containers/:id` | `Container` | Yes |
| `containers.revokeKey({ containerId, keyId })` | `DELETE /v1/containers/:id/keys/:keyId` | `RevokeContainerKeyResponse` | Yes |
| `containers.delete({ containerId, confirm: true })` | `DELETE /v1/containers/:id` | `DeleteContainerResponse` | Yes |

**Container name uniqueness:** Creating a container with a name that already exists under the same parent account returns 409 with error code `container_name_exists`. The `details.existing_container_id` field contains the ID of the existing container, enabling idempotent-feeling provisioning — an agent retrying after a timeout can use the existing container instead of creating a duplicate.

**`scopes` accepts `string | string[]`:** When creating a container key, you can pass scopes as a comma-separated string (`"memory:read,memory:write"`) or as an array of strings (`["memory:read", "memory:write"]`). The SDK normalizes arrays to comma-separated strings before sending.

### Container / ContainerKey types

```ts
interface Container {
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

interface ContainerKey {
  id: string;
  accountId: string;
  keyPrefix: string;
  scopes: string;
  issuedTo: string | null;
  expiresAt: string | null;
  createdAt: string;
}
```

### Key scopes

| Scope | Grants |
|-------|--------|
| `memory:read` | `get`, `recall`, `list`, `health`, `whoami`, `usage` |
| `memory:write` | `add`, `remove`, `delete` |
| `account:admin` | Container management endpoints, extraction prompt CRUD |

### Key expiry

Keys can have an `expiresAt` timestamp. Expired keys return 401 with error code `key_expired`. Set via `expiresIn` (TTL in seconds, max 31536000 = 1 year) when creating a key.

### Soft revocation

Keys are soft-revoked by setting `revoked_at` instead of deleting the row. Revoked keys return 401 `unauthorized`.

### Quota inheritance

Container memories count against the parent account's `memory_limit`. The quota check sums active (non-superseded) memories across the parent and all its containers. When the combined limit is reached, writes on both the parent and containers return 403 `quota_exceeded`.

## SDK vs HTTP API divergence

The SDK provides ergonomic wrappers that differ from the raw HTTP responses:

| Feature | SDK behavior | HTTP behavior |
|---------|-------------|---------------|
| Container create/list/get | Returns unwrapped `Container` / `Container[]` | Returns `{ container: {...} }` / `{ containers: [...] }` envelope |
| Container key scopes | Accepts `string \| string[]` | Expects comma-separated `string` |
| Cache create | Returns `CacheInstance` with bound methods | Returns `{ cache: { rawToken, claimToken, ... } }` |
| Errors | Typed subclasses with `instanceof` | JSON `{ error: { code, message, details } }` |
| Auth header | Automatic from config | Manual `Authorization: Bearer ...` |
