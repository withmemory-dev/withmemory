# WithMemory

Persistent memory for AI agents.

WithMemory is the default memory layer for AI agents — zero infrastructure, two API calls, every user gets persistent context from session one.

## Status

Pre-alpha. Under active development. Not yet published.

## Architecture

WithMemory is a monorepo containing:

- `packages/sdk` — TypeScript client SDK (`@withmemory/sdk`)
- `packages/server` — API server, deployed as a Cloudflare Worker
- `packages/extraction` — LLM extraction pipeline
- `packages/shared` — Shared types and utilities
- `packages/eval` — Extraction quality evaluation suite
- `apps/dashboard` — Web dashboard (Next.js)
- `apps/docs` — Documentation site
- `infra/migrations` — Database migrations
- `examples/` — Integration examples

## License

The SDK (`packages/sdk`) is licensed under Apache 2.0.
The server (`packages/server`) is licensed under BUSL 1.1, converting to Apache 2.0 after four years.

See individual `LICENSE` files in each package for details.
