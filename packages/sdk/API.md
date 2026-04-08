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

### Error codes — Session 2

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

### Error codes — future sessions

These codes do not exist yet. They are listed here so nobody adds them prematurely.

| Code                  | Planned Session | Purpose                                              |
|-----------------------|-----------------|------------------------------------------------------|
| `rate_limited`        | Session 5       | Account has exceeded its request quota                |
| `extraction_failed`   | Session 3       | LLM extraction encountered an unrecoverable error    |
| `quota_exceeded`      | Session 5       | Account has exceeded its memory storage quota         |
| `internal_error`      | Session 3+      | Unclassified server error (5xx)                      |

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
}
```

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

**`commit()` is fire-and-forget.** It catches all errors internally and never throws. A 404 today (route not yet built) silently no-ops. This is the one exception to the error contract.

**`getUserMemories()` and `deleteMemory()`** routes are not yet built on the server. They will return `not_found` (404) until Session 3 adds the server-side handlers. The SDK methods are fully implemented fetch wrappers — no client-side stubs or special-casing.
