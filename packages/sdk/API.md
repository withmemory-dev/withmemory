# @withmemory/sdk — API Contract Reference

This file is the canonical in-repo reference for the SDK's public surface. It documents the types, error codes, and response shapes that the SDK and server must agree on. When the SDK types and this file disagree, this file wins.

## Route conventions

All `/v1/*` routes are POST with JSON bodies, except DELETE on resources addressed by primary key (e.g., `DELETE /v1/memories/:id`) and GET for read-only status endpoints (e.g., `GET /v1/health`). The `userId` field is a filter within the account's data, not an addressable resource — it lives in the request body, never in the URL path or query string.

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

| Code              | Origin      | HTTP Status | When                                                        |
|-------------------|-------------|-------------|-------------------------------------------------------------|
| `unauthorized`    | Server      | 401         | Missing, malformed, or invalid API key                      |
| `invalid_request` | Server      | 400         | Request body fails Zod validation                           |
| `not_found`       | Server      | 404         | Route does not exist or resource not found                   |
| `timeout`         | SDK         | 0           | Request exceeded the configured timeout                      |
| `network_error`   | SDK         | 0           | Fetch failed (DNS, connection refused, TLS, offline, etc.)  |

**Convention:** Error codes are `snake_case_lower`, matching OpenAI and Stripe conventions and the server's existing style.

**Server-side codes** are returned in the standard error envelope: `{ error: { code, message, details? } }`. The SDK parses this envelope and maps it to a `WithMemoryError` instance.

**SDK-side codes** (`timeout`, `network_error`) are generated client-side when the HTTP request itself fails before the server can respond. These always have `status: 0`.

### Error codes — planned

These codes do not exist yet. They are listed here so nobody adds them prematurely.

| Code                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `rate_limited`        | Account has exceeded its request quota                |
| `extraction_failed`   | LLM extraction error surfaced to caller (currently internal-only on the exchange row) |
| `quota_exceeded`      | Account has exceeded its memory storage quota         |
| `internal_error`      | Unclassified server error (5xx)                      |

## Types

### Memory

The canonical memory object returned by `set`, `get`, `recall`, and list operations:

```ts
interface Memory {
  id: string;
  userId: string;
  key: string | null;   // null for extracted memories (source: "extracted")
  value: string;        // the memory content — named "value" in the SDK, "content" in the DB
  source: "explicit" | "extracted";
  createdAt: string;    // ISO 8601
  updatedAt: string;    // ISO 8601
}
```

**Note:** The server stores the text in a column named `content`. The SDK maps this to `value` in all responses to match the `set(userId, key, value)` calling convention. This mapping happens in the server's route handlers, not in the SDK.

### RecallResponse

```ts
interface RecallResponse {
  promptBlock: string;       // Always a string, never null. Empty string if no memories.
  memories: Memory[];        // The memories that contributed to the promptBlock.
  ranking: {
    strategy: "semantic" | "recency_importance" | "user_not_found";
    reason?: "embedding_unavailable";
  };
}
```

The `ranking` field describes how the returned memories were ordered:

- **`"semantic"`** — memories were ranked by cosine similarity against an embedding of the query input, combined with recency decay, importance, and source tier. This is the normal path.
- **`"recency_importance"`** — the query embedding could not be generated (typically because the embeddings API was unavailable), so memories were ranked by recency and importance only, with source tier still applied. The `reason` field is set to `"embedding_unavailable"` in this case. Clients can choose to retry, degrade, or proceed with the returned memories as-is.
- **`"user_not_found"`** — the requested `userId` does not exist under the authenticated account, so there were no memories to rank. The `memories` array is empty. The `promptBlock` may still contain registered defaults if any were provided in the request. This is not an error; it's a normal response for first-contact with a new end user.

The `ranking` field is additive and backward-compatible. SDK clients that don't know about it will continue to work unchanged. The SDK's `RecallResponse` type now includes the `ranking` field.

### SetResponse

```ts
interface SetResponse {
  memory: Memory;
}
```

### GetResponse

```ts
interface GetResponse {
  memory: Memory | null;     // null if the key does not exist for this user
}
```

### RemoveResponse

```ts
interface RemoveResponse {
  deleted: boolean;          // true if a memory was found and removed
}
```

### HealthResponse

```ts
interface HealthResponse {
  status: "ok";
  version: string;
}
```

`GET /v1/health` is authenticated — it sits behind the same Bearer token middleware as all other `/v1/*` routes. This means `health()` validates both service availability and API key validity. Unauthenticated health checks are available at `/health` and `/health/db` on the root app.

### ExtractionPromptResponse

```ts
interface ExtractionPromptResponse {
  prompt: string | null;    // the custom prompt text, or null if using default
  source: "custom" | "default";
}
```

Returned by both `setExtractionPrompt()` and `getExtractionPrompt()`. When `source` is `"custom"`, `prompt` contains the account's custom extraction prompt. When `source` is `"default"`, `prompt` is `null` and the server uses the bundled extraction prompt.

### ResetExtractionPromptResponse

```ts
interface ResetExtractionPromptResponse {
  reset: boolean;           // always true
}
```

## SDK methods

| Method                              | HTTP                          | Returns              | Throws on error? |
|-------------------------------------|-------------------------------|----------------------|-------------------|
| `configure(config)`                 | —                             | `void`               | Yes               |
| `register(defaults)`               | —                             | `void`               | Yes               |
| `set(userId, key, value)`          | `POST /v1/set`                | `SetResponse`        | Yes               |
| `get(userId, key)`                 | `POST /v1/get`                | `GetResponse`        | Yes               |
| `recall({ userId, input, ... })`   | `POST /v1/recall`             | `RecallResponse`     | Yes               |
| `remove(userId, key)`              | `POST /v1/remove`             | `RemoveResponse`     | Yes               |
| `commit({ userId, input, output })`| `POST /v1/commit`             | `void`               | **Never**         |
| `getUserMemories(userId)`          | `POST /v1/memories`           | `Memory[]`           | Yes               |
| `deleteMemory(memoryId)`           | `DELETE /v1/memories/:id`     | `RemoveResponse`     | Yes               |
| `health()`                         | `GET /v1/health`              | `HealthResponse`     | Yes               |
| `setExtractionPrompt(prompt)`     | `POST /v1/account/extraction-prompt` | `ExtractionPromptResponse` | Yes          |
| `getExtractionPrompt()`           | `GET /v1/account/extraction-prompt`  | `ExtractionPromptResponse` | Yes          |
| `resetExtractionPrompt()`         | `DELETE /v1/account/extraction-prompt` | `ResetExtractionPromptResponse` | Yes   |

**`register(defaults)`** stores defaults on the client instance. Defaults are forwarded in the `recall()` request body as a `defaults` field and appear in the `promptBlock` as tier 4 fallback (after explicit, extracted, and summary memories). Defaults do NOT appear in the `memories` array — they are prompt-block-only.

**`commit()` is fire-and-forget.** It catches all errors internally and never throws. The server returns 202 immediately and runs extraction asynchronously. Supports an `Idempotency-Key` header (max 255 chars) — repeated calls with the same key return 202 without re-processing. This is the one exception to the error contract.

**`recall()` accepts optional `defaults`** — a `Record<string, string>` of key-value pairs to include in the prompt block when real memories don't fill the budget. Per-call defaults merge with (and override) any defaults set via `register()`. The `memories` array in the response reflects real database rows only.

**`getUserMemories()`** returns all non-superseded memories for a user as a bare `Memory[]` array (not wrapped in an envelope). Returns `[]` if the user does not exist. **`deleteMemory()`** deletes a memory by ID with account-level ownership check.

**`setExtractionPrompt(prompt)`** sets a custom extraction prompt for the authenticated account. The prompt must be 1–32,768 characters after trimming whitespace. The custom prompt is used instead of the bundled default when `commit()` runs extraction. **`getExtractionPrompt()`** reads the current prompt state. **`resetExtractionPrompt()`** clears the custom prompt, reverting to the bundled default.
