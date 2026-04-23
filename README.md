# WithMemory

Persistent memory for AI agents. Two API calls. Zero configuration.

WithMemory gives AI agents persistent context across sessions. Developers integrate with `memory.add()` and `memory.recall()` — agents stop forgetting users between conversations.

## Install

```bash
npm install @withmemory/sdk
```

## Quickstart

```typescript
import { memory } from "@withmemory/sdk";

// Stores a fact
await memory.add({ scope: "user-alice", key: "name", value: "Alice Chen" });

// Retrieves relevant context
const { context } = await memory.recall({
  scope: "user-alice",
  query: "who is this?",
});
// → "name: Alice Chen"
```

Set `WITHMEMORY_API_KEY` in your environment, or call `memory.configure({ apiKey: "wm_live_..." })` explicitly. Omit `key` on `add()` to let the LLM extract durable facts from free-form text.

## What's in this repo

- [`packages/sdk`](packages/sdk) — TypeScript client SDK (`@withmemory/sdk`) · [README](packages/sdk/README.md) · [API Reference](packages/sdk/API.md)
- [`packages/server`](packages/server) — API server (Cloudflare Worker, live at `api.withmemory.dev`)
- [`packages/eval`](packages/eval) — Extraction quality evaluation suite
- [`infra/migrations`](infra/migrations) — Database migrations (PostgreSQL + pgvector)
- [`examples/`](examples) — Integration examples (Vercel AI SDK, plain TypeScript)

## Key features

- **Two-call integration** — `add()` to store, `recall()` to retrieve a prompt-ready context string
- **Automatic extraction** — omit `key` on `add()` and the LLM extracts durable facts from conversation text
- **Semantic ranking** — cosine similarity, recency decay, importance scoring, and source-tier weighting
- **Configurable precision** — `threshold: "strict" | "balanced" | "permissive"` on `recall()`
- **Agent self-service** — containers for workspace isolation, scoped keys with TTL, zero-auth cache for bootstrap
- **Pre-auth signup** — `memory.requestCode({ email })` + `memory.verifyCode({ email, code, issuedTo? })` with no prior configuration
- **TypeScript-first** — zero runtime dependencies, works on Node 18+, Bun, Deno, and Cloudflare Workers
- **Self-hostable** — the server runs against any PostgreSQL with the pgvector extension

## Documentation

- [SDK README](packages/sdk/README.md) — full SDK documentation with examples
- [API Reference](packages/sdk/API.md) — endpoint contracts, types, error codes
- [withmemory.dev](https://withmemory.dev) — product site
- [For AI Agents](https://withmemory.dev/SKILL.md) — machine-readable product description (agent-ready)

## License

- SDK (`packages/sdk`): Apache 2.0
- Server (`packages/server`): BUSL 1.1, converting to Apache 2.0 after four years

See [`LICENSE`](LICENSE) for the Apache 2.0 text that applies to this repository's open-source contents.
