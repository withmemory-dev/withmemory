# @withmemory/sdk

Your context window resets. Your users don't.

WithMemory gives AI agents persistent memory — store facts about users, recall them before every response, forget nothing between sessions. Two API calls. Zero configuration.

## Install

```bash
npm install @withmemory/sdk
```

## Quick start

```typescript
import { memory } from "@withmemory/sdk";

memory.configure({ apiKey: process.env.WITHMEMORY_API_KEY });

// Store a fact (LLM extraction)
await memory.add({
  scope: "user-alice",
  value: "Lives in Brooklyn, prefers dark mode, works at Stripe"
});

// Recall context before your next LLM call
const { context } = await memory.recall({
  scope: "user-alice",
  query: "Where does the user live?"
});

// context: "Lives in Brooklyn. Prefers dark mode. Works at Stripe."
```

## Explicit key-value storage

```typescript
await memory.add({
  scope: "user-alice",
  key: "name",
  value: "Alice Chen"
});

const { memory: mem } = await memory.get({
  scope: "user-alice",
  key: "name"
});
```

When `key` is provided, the value is stored directly — no LLM extraction. When `key` is omitted, WithMemory runs extraction to identify durable facts.

## Identity scoping

`scope` identifies whose memories these are. Use a stable identifier like a database UUID or auth provider ID — not a session ID or cookie.

```typescript
// Good — stable across devices
await memory.add({ scope: user.id, value: "..." });

// Bad — different ID per device
await memory.add({ scope: cookies.get("session"), value: "..." });
```

## Container namespaces

Containers are isolated memory environments for autonomous agents.

```typescript
const container = await memory.containers.create({
  name: "support-bot"
});

const key = await memory.containers.createKey({
  containerId: container.id,
  issuedTo: "support-bot-v2",
  scopes: ["memory:read", "memory:write"]
});

// Save key.rawKey — it cannot be retrieved again
import { createClient } from "@withmemory/sdk";
const bot = createClient({ apiKey: key.rawKey });
await bot.add({ scope: "customer-123", value: "Prefers email" });
```

## Temporary cache (no signup required)

```typescript
const cache = await memory.cache.create();

await cache.set({ key: "draft", value: "..." });
const { entry } = await cache.get({ key: "draft" });

// Share cache.claimUrl to make it permanent
```

Caches expire in 24 hours. No API key needed.

## Error handling

```typescript
import { QuotaExceededError } from "@withmemory/sdk";

try {
  await memory.add({ scope: "alice", value: "..." });
} catch (err) {
  if (err instanceof QuotaExceededError) {
    console.log(err.details.recovery_options);
  }
}
```

15 typed error subclasses with `instanceof` support. Auto-retry with exponential backoff on transient failures (configurable).

## Get a key without a browser

```bash
# 1. Request a code
curl -sS https://api.withmemory.dev/v1/auth/request-code \
  -H "content-type: application/json" \
  -d '{"email": "you@example.com"}'

# 2. Verify the code from your email
curl -sS https://api.withmemory.dev/v1/auth/verify-code \
  -H "content-type: application/json" \
  -d '{"email": "you@example.com", "code": "847293"}'
```

## Methods

| Method | Description |
|--------|-------------|
| `add({ scope, value })` | Extract and store facts |
| `add({ scope, key, value })` | Store directly by key |
| `recall({ scope, query })` | Get prompt-ready context |
| `get({ scope, key })` | Read a single memory |
| `remove({ scope, key })` | Delete by scope + key |
| `delete(memoryId)` | Delete by ID |
| `list(options?)` | Enumerate memories |
| `whoami()` | Account metadata + key scopes |
| `usage()` | Current quota usage |
| `cache.create()` | Ephemeral KV cache |
| `cache.claim({ claimToken })` | Promote cache to permanent |
| `containers.create({ name })` | Isolated namespace |
| `containers.createKey(...)` | Mint scoped credential |
| `containers.get(...)` | Container details |
| `containers.list()` | List containers |
| `containers.revokeKey(...)` | Revoke a key |
| `containers.delete(...)` | Delete container |

## Configuration

```typescript
import { memory, createClient } from "@withmemory/sdk";

// Singleton (most apps)
memory.configure({
  apiKey: "wm_live_...",
  clientId: "my-agent/1.0",  // optional attribution
});

// Factory (multi-tenant)
const client = createClient({
  apiKey: "wm_live_...",
  maxRetries: 5,
  timeout: 30000,
});
```

## Documentation

- [SKILL.md](https://withmemory.dev/SKILL.md) — agent-readable integration guide
- [API Reference](./API.md) — full endpoint and type documentation
- [Dashboard](https://app.withmemory.dev) — manage keys, view memories, configure extraction

## License

Apache 2.0
