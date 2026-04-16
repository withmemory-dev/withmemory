# WithMemory — Setup and Development Guide

**Status:** Pre-alpha. Server API, SDK, extraction pipeline, semantic ranking, and dedup are live. Dashboard and billing not yet built.
**Last updated:** April 2026

## What is WithMemory

WithMemory is the default memory layer for AI agents. Developers integrate it with two API calls — `memory.add()` to store facts (pass `key` for explicit writes or omit it to trigger synchronous LLM extraction), and `memory.recall()` to retrieve a prompt-ready context block before every LLM invocation.

This repository contains the server (API + extraction pipeline) and the client SDK. It is a pnpm workspace monorepo.

## Architecture

**Runtime:** Cloudflare Workers (via Hono, which also runs on Node/Bun/Deno for self-hosters)
**API framework:** Hono
**Database:** PostgreSQL with pgvector extension
**Hosted DB:** Supabase (project: `withmemory-prod`, region: us-west-1)
**Query layer:** Drizzle ORM (typed queries, schema as source of truth)
**Driver:** postgres-js (serverless-friendly, works in Workers)
**Migrations:** Drizzle Kit generates plain SQL files
**Embeddings:** OpenAI text-embedding-3-small at 512 dimensions (Matryoshka truncation)
**Extraction LLM:** OpenAI gpt-4.1-mini

The server is designed to be runtime-agnostic. The hosted version runs on Cloudflare Workers with Supabase Postgres. Self-hosters can run the same code on Node with any Postgres provider by swapping the `DATABASE_URL` and deploying via Docker.

## Monorepo structure
withmemory/
├── packages/
│   ├── sdk/              # @withmemory/sdk — TypeScript client (Apache 2.0)
│   ├── server/           # API server, runs on Cloudflare Workers (BUSL 1.1)
│   └── eval/             # Extraction quality evaluation suite
├── examples/
│   └── vercel-ai-sdk/    # Integration example with Vercel AI SDK
├── infra/
│   └── migrations/       # Generated SQL migration files (portable)
└── supabase/             # Local Supabase CLI config

Packages follow the `@withmemory/*` naming convention on npm. Infra and supabase are tooling.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker Desktop (for local Supabase)
- Supabase CLI (`brew install supabase/tap/supabase`)
- Wrangler CLI (installed per-package via pnpm, no global install needed)
- psql (optional, for ad-hoc database debugging)

## Getting started

Clone the repo and install dependencies:
```bash
git clone git@github.com:withmemory-dev/withmemory.git
cd withmemory
pnpm install
```

Copy the env template and fill in your values:
```bash
cp packages/server/.env.example packages/server/.env.local
```

Open `packages/server/.env.local` in your editor and set:

- `DATABASE_URL` — already correct for local Supabase, leave as-is
- `PROD_DIRECT_URL` — only needed if you're applying migrations to production (direct connection, port 5432)

Create `.dev.vars` for local Worker dev:
```bash
cat > packages/server/.dev.vars << 'VARS'
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
VARS
```

Start local Supabase:
```bash
supabase start
```

First run pulls ~2GB of Docker images and takes 5-10 minutes. Subsequent starts take 20-30 seconds.

Apply migrations to local:
```bash
pnpm --filter @withmemory/server db:migrate
```

Start the local dev server:
```bash
pnpm --filter @withmemory/server dev
```

Verify it works:
```bash
curl http://localhost:8787/health/db
```

You should see `{"status":"ok","database":"connected",...}`.

## Daily workflow

### Schema changes

1. Edit `packages/server/src/db/schema.ts` — this is the source of truth for the database schema
2. Generate a migration: `pnpm --filter @withmemory/server db:generate`
3. **Read the generated SQL file** in `infra/migrations/` before applying it
4. Apply to local: `pnpm --filter @withmemory/server db:migrate`
5. Test your changes locally
6. Apply to production: `pnpm --filter @withmemory/server db:migrate:prod`
7. Commit the migration file and schema change together

### Code changes

1. Edit files in `packages/server/src/`
2. Wrangler hot-reloads automatically
3. Test endpoints with curl or your HTTP client of choice
4. When ready to ship: `pnpm --filter @withmemory/server worker:deploy`
5. Commit and push

### Deploying the server
```bash
pnpm --filter @withmemory/server worker:deploy
```

This runs `wrangler deploy`, which bundles the code and ships it to Cloudflare. The deployed Worker is at `https://api.withmemory.dev`.

## Secret management

- **`.env.local`** — local development secrets for Drizzle Kit (database URLs). Gitignored. Per-developer.
- **`.dev.vars`** — local Worker dev secrets for Wrangler. Gitignored. Per-developer.
- **`.env.example`** — template showing what variables need to be set. Committed.
- **Production Worker secrets** — set via `wrangler secret put VAR_NAME`, stored in Cloudflare's encrypted vault. Never in files.

**Never commit `.env.local` or `.dev.vars`.** They are gitignored but always double-check `git status` before committing.

## Data model

Five tables, all prefixed `wm_`:

**`wm_accounts`** — WithMemory customers (developers). One row per signup.

**`wm_api_keys`** — API keys belonging to accounts. Stores hashed keys, never plaintext. Indexed on `key_hash` for fast lookup during request authentication.

**`wm_end_users`** — The developers' end users. Identified by `external_id`, which is whatever string the developer passes as `scope`. Unique within an account.

**`wm_exchanges`** — Conversation turns submitted to `memory.add()` without `key` (the extraction path). Stores inputs, extraction status, and prompt version for eval harness analysis. Supports idempotency via a partial unique index on `(account_id, idempotency_key)`.

**`wm_memories`** — The actual memories. Both explicit (`memory.add()` with `key`) and extracted (`memory.add()` without `key`) live here, distinguished by a `source` column. Has a `vector(512)` embedding column with an HNSW index for cosine similarity search. Extracted memories link back to their source exchange via `exchange_id`.

See `packages/server/src/db/schema.ts` for the full definitions.

## Deployment targets

- **Production API:** `https://api.withmemory.dev` → `withmemory-api` Worker
- **Production database:** Supabase project `withmemory-prod`, region us-west-1

## What exists

- **Server routes:** Twenty-seven `/v1/*` routes are live, grouped by area:
  - **Memories (7):** `POST /v1/memories` (add, explicit or extraction), `POST /v1/memories/get`, `POST /v1/memories/remove`, `POST /v1/memories/list`, `DELETE /v1/memories/:id`, `POST /v1/recall`, `GET /v1/health`
  - **Account (5):** `GET /v1/account` (whoami), `GET /v1/account/usage`, `POST/GET/DELETE /v1/account/extraction-prompt`
  - **Containers (6):** `POST /v1/containers`, `GET /v1/containers`, `GET /v1/containers/:id`, `POST /v1/containers/:id/keys`, `DELETE /v1/containers/:id/keys/:keyId`, `DELETE /v1/containers/:id`
  - **Cache (7):** `POST /v1/cache` (create), `POST /v1/cache/preview`, `POST /v1/cache/set`, `POST /v1/cache/get`, `POST /v1/cache/delete`, `GET /v1/cache/list`, `POST /v1/cache/claim`
  - **Auth (2):** `POST /v1/auth/request-code`, `POST /v1/auth/verify-code`

  Memory/account/container routes require Bearer API key auth. Cache CRUD uses short-lived cache tokens (also Bearer). Cache creation/preview and the two `/auth/*` routes are unauthenticated.
- **Extraction pipeline:** `POST /v1/memories` without `key` triggers synchronous LLM extraction before returning (200 with the extracted memories in the response). Extraction uses gpt-4.1-mini, embeddings use text-embedding-3-small at 512 dimensions. Supports `Idempotency-Key` header. Customer-configurable extraction prompts via the account routes.
- **Semantic ranking:** `recall()` ranks memories by cosine similarity, recency decay, importance, and source tier (explicit > extracted). Similarity floor at 0.2.
- **Deduplication:** Extracted memories are classified against existing ones — near-duplicates (>=0.92) supersede, conflicts (0.78-0.92) respect explicit > extracted hierarchy, novel facts (<0.78) insert normally.
- **SDK:** `@withmemory/sdk` at `packages/sdk/` — 21 methods live (13 core methods plus 6 on `memory.containers.*` and 2 on `memory.cache.*`; `cache.create()` returns a `CacheInstance` with 4 additional methods for entry CRUD). `register()` stores defaults and forwards them to `recall()` as a tier-4 fallback.
- **Auth:** API key middleware with SHA-256 hash lookup and `last_used_at` fire-and-forget updates via `ctx.waitUntil`.
- **E2E tests:** 72 tests passing against production (55 in `test-add-recall.ts` covering memories/recall/list/extraction/quotas, 17 in `test-containers.ts` covering Path B container endpoints and cross-account isolation). Both suites require `WITHMEMORY_API_KEY_B` and `DATABASE_URL`.
- **Eval harness:** `packages/eval/` with 50 extraction fixtures (extraction eval) and 30 recall fixtures (recall eval with ranking quality metrics).
- **Plan enforcement:** `POST /v1/memories` checks memory quota before every write, including the extraction path (403 `quota_exceeded`). `POST /v1/account/extraction-prompt` and all `POST /v1/containers*` routes are gated to pro/team/enterprise tiers (403 `plan_required`). `POST /v1/cache/claim` enforces the parent account's memory quota before creating the container and memories.
- **Example:** `examples/vercel-ai-sdk/` demonstrates the SDK integration pattern with the Vercel AI SDK.

## Test baselines

| Suite | Baseline | Command |
|---|---|---|
| Ranking | 37/37 | `npx tsx packages/server/scripts/test-ranking.ts` |
| Extraction | 50/50 | `pnpm --filter @withmemory/eval eval` |
| Recall | 24/30 | `pnpm --filter @withmemory/eval test:recall-eval` |
| E2E (local) | 40/40 (41 with API_KEY_B) | `pnpm test:e2e` |
| E2E (prod) | 41/41 | `pnpm test:e2e` with prod env vars |

**E2E env vars required:**
- `WITHMEMORY_API_KEY` — test account API key (required)
- `WITHMEMORY_API_KEY_B` — second test account key for cross-account test (optional, +1 test)
- `DATABASE_URL` — direct Postgres connection for plan enforcement test helpers

**Extraction and recall evals** require `OPENAI_API_KEY` via `source packages/server/.env.local`.

## Scope

This repo contains the SDK (`packages/sdk`) and server (`packages/server`). The dashboard, billing, and documentation site live in separate repositories.

## Further reading

- `CLAUDE.md` — Context and conventions for AI coding assistants
- `CONTRIBUTING.md` — How to contribute (placeholder until public)
- `packages/server/src/db/schema.ts` — Database schema source of truth
- `infra/migrations/` — Generated SQL migrations (portable, reviewable)
