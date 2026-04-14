# @withmemory/sdk — API Contract Reference

This file is the canonical in-repo reference for the SDK's public surface. It documents the types, error codes, and response shapes that the SDK and server must agree on. When the SDK types and this file disagree, this file wins.

## Quick start

```ts
import { memory } from "@withmemory/sdk";

memory.configure({ apiKey: "wm_..." });

await memory.set({
  value: "Andrew",
  forKey: "name",
  forScope: "user_alice"
});

const { context } = await memory.recall({
  forScope: "user_alice",
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

All `/v1/*` routes are POST with JSON bodies, except DELETE on resources addressed by primary key (e.g., `DELETE /v1/memories/:id`) and GET for read-only status endpoints (e.g., `GET /v1/health`). The `forScope` field is a filter within the account's data, not an addressable resource — it lives in the request body, never in the URL path or query string.

## Error handling

### WithMemoryError

All SDK errors are instances of `WithMemoryError`, which extends `Error`:

```ts
class WithMemoryError extends Error {
  status: number;    // HTTP status code (0 for network/timeout errors)
  code: string;      // Machine-readable error code (see table below)
  details?: unknown; // Optional structured details (e.g., Zod validation issues)
}
```

### Error codes

| Code | Origin | HTTP Status | When |
|------|--------|-------------|------|
| `unauthorized` | Server | 401 | Missing, malformed, or invalid API key |
| `key_expired` | Server | 401 | API key has passed its `expires_at` timestamp |
| `invalid_request` | Server | 400 | Request body fails Zod validation |
| `not_found` | Server | 404 | Route does not exist or resource not found |
| `quota_exceeded` | Server | 403 | Account memory limit reached (summed across parent + containers) |
| `plan_required` | Server | 403 | Feature requires a higher plan tier |
| `container_limit_exceeded` | Server | 403 | Account has reached its container cap |
| `confirmation_required` | Server | 400 | Destructive action requires `{ confirm: true }` in body |
| `timeout` | SDK | 0 | Request exceeded the configured timeout |
| `network_error` | SDK | 0 | Fetch failed (DNS, connection refused, TLS, offline, etc.) |

## Types

### Memory

The canonical memory object returned by `set`, `get`, `recall`, and list operations:

```ts
interface Memory {
  id: string;
  forScope: string;
  forKey: string | null;   // null for extracted memories (source: "extracted")
  value: string;           // the memory content — named "value" in the SDK, "content" in the DB
  source: "explicit" | "extracted";
  status: "ready" | "pending" | "failed";
  statusError: string | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
```

### RecallResponse

```ts
interface RecallResponse {
  context: string;         // Always a string, never null. Empty string if no memories.
  memories: Memory[];      // The memories that contributed to the context (status: "ready" only).
  ranking: {
    strategy: "semantic" | "recency_importance" | "user_not_found";
    reason?: "embedding_unavailable";
  };
}
```

The `ranking` field describes how the returned memories were ordered:

- **`"semantic"`** — memories were ranked by cosine similarity against an embedding of the query, combined with recency decay, importance, and source tier.
- **`"recency_importance"`** — the query embedding could not be generated, so memories were ranked by recency and importance only. The `reason` field is `"embedding_unavailable"`.
- **`"user_not_found"`** — the requested `forScope` does not exist under the authenticated account. The `memories` array is empty. The `context` may still contain registered defaults.

### SetResponse / GetResponse / RemoveResponse / HealthResponse

```ts
interface SetResponse { memory: Memory; }
interface GetResponse { memory: Memory | null; }
interface RemoveResponse { deleted: boolean; }
interface HealthResponse { status: "ok"; version: string; }
```

### ListOptions / ListResponse

```ts
interface ListOptions {
  forScope?: string;         // Filter by scope. Omit for account-wide listing.
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
}
```

### ExtractionPromptResponse / ResetExtractionPromptResponse

```ts
interface ExtractionPromptResponse {
  prompt: string | null;
  source: "custom" | "default";
}

interface ResetExtractionPromptResponse {
  reset: boolean;
}
```

## SDK methods

| Method | HTTP | Returns | Throws on error? |
|--------|------|---------|-------------------|
| `configure(config)` | — | `void` | Yes |
| `register(defaults)` | — | `void` | Yes |
| `set({ forScope, forKey, value })` | `POST /v1/set` | `SetResponse` | Yes |
| `get({ forScope, forKey })` | `POST /v1/get` | `GetResponse` | Yes |
| `recall({ forScope, query, ... })` | `POST /v1/recall` | `RecallResponse` | Yes |
| `remove({ forScope, forKey })` | `POST /v1/remove` | `RemoveResponse` | Yes |
| `commit({ forScope, input, output })` | `POST /v1/commit` | `void` | **Never** |
| `list(options?)` | `POST /v1/memories/list` | `ListResponse` | Yes |
| `deleteMemory(memoryId)` | `DELETE /v1/memories/:id` | `RemoveResponse` | Yes |
| `health()` | `GET /v1/health` | `HealthResponse` | Yes |
| `setExtractionPrompt(prompt)` | `POST /v1/account/extraction-prompt` | `ExtractionPromptResponse` | Yes |
| `getExtractionPrompt()` | `GET /v1/account/extraction-prompt` | `ExtractionPromptResponse` | Yes |
| `resetExtractionPrompt()` | `DELETE /v1/account/extraction-prompt` | `ResetExtractionPromptResponse` | Yes |

**`register(defaults)`** stores defaults on the client instance. Defaults are forwarded in the `recall()` request body as a `defaults` field and appear in the `context` as tier 4 fallback (after explicit, extracted, and summary memories). Defaults do NOT appear in the `memories` array — they are prompt-block-only.

**`commit()` is fire-and-forget.** It catches all errors internally and never throws. The server returns 202 immediately and runs extraction asynchronously. Supports an `Idempotency-Key` header (max 255 chars).

**`recall()` accepts optional `defaults`** — a `Record<string, string>` of key-value pairs to include in the context when real memories don't fill the budget. Per-call defaults merge with (and override) any defaults set via `register()`. Only memories with `status: "ready"` are returned.

**`list(options?)`** lists non-superseded memories with optional filtering, search, sort, and cursor-based pagination. Supports account-wide listing (omit `forScope`) or per-scope listing (provide `forScope`). Cursors are opaque strings using keyset pagination internally.

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
| `containers.create({ name, metadata? })` | `POST /v1/containers` | `CreateContainerResponse` | Yes |
| `containers.createKey({ forContainer, issuedTo, scopes?, expiresIn? })` | `POST /v1/containers/:id/keys` | `CreateContainerKeyResponse` | Yes |
| `containers.list()` | `GET /v1/containers` | `ListContainersResponse` | Yes |
| `containers.get({ forContainer })` | `GET /v1/containers/:id` | `GetContainerResponse` | Yes |
| `containers.revokeKey({ forContainer, forKey })` | `DELETE /v1/containers/:id/keys/:keyId` | `RevokeContainerKeyResponse` | Yes |
| `containers.delete({ forContainer, confirm: true })` | `DELETE /v1/containers/:id` | `DeleteContainerResponse` | Yes |

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
| `memory:read` | `get`, `recall`, `list`, `health` |
| `memory:write` | `set`, `remove`, `commit`, `deleteMemory` |
| `account:admin` | Container management endpoints, extraction prompt CRUD |

### Key expiry

Keys can have an `expiresAt` timestamp. Expired keys return 401 with error code `key_expired`. Set via `expiresIn` (TTL in seconds, max 31536000 = 1 year) when creating a key.

### Soft revocation

Keys are soft-revoked by setting `revoked_at` instead of deleting the row. Revoked keys return 401 `unauthorized`.

### Quota inheritance

Container memories count against the parent account's `memory_limit`. The quota check sums active (non-superseded) memories across the parent and all its containers. When the combined limit is reached, writes on both the parent and containers return 403 `quota_exceeded`.
