# WithMemory — Setup and Development Guide

**Status:** Pre-alpha. Infrastructure complete, product routes not yet built.
**Last updated:** April 2026

## What is WithMemory

WithMemory is the default memory layer for AI agents. Developers integrate it with two API calls — `memory.set()` to store facts explicitly, and `memory.recall()` to retrieve a prompt-ready context block before every LLM invocation. A third call, `memory.commit()`, runs async LLM extraction to pull durable facts out of conversation turns.

The product positioning: zero configuration, TypeScript-first, works in five minutes, self-hostable on any Postgres.

This repository contains the server (API + extraction pipeline), the client SDK, the dashboard, and the documentation site. It is a pnpm workspace monorepo.

## Architecture

**Runtime:** Cloudflare Workers (via Hono, which also runs on Node/Bun/Deno for self-hosters)
**API framework:** Hono
**Database:** PostgreSQL with pgvector extension
**Hosted DB:** Supabase (project: `withmemory-prod`, region: us-west-1)
**Query layer:** Drizzle ORM (typed queries, schema as source of truth)
**Driver:** postgres-js (serverless-friendly, works in Workers)
**Migrations:** Drizzle Kit generates plain SQL files
**Embeddings (planned):** OpenAI text-embedding-3-small at 512 dimensions
**Extraction LLM (planned):** OpenAI gpt-4.1-mini

The server is designed to be runtime-agnostic. The hosted version runs on Cloudflare Workers with Supabase Postgres. Self-hosters can run the same code on Node with any Postgres provider by swapping the `DATABASE_URL` and deploying via Docker.

## Monorepo structure
withmemory/
├── packages/
│   ├── sdk/              # @withmemory/sdk — TypeScript client (Apache 2.0)
│   ├── server/           # API server, runs on Cloudflare Workers (BUSL 1.1)
│   ├── extraction/       # LLM extraction pipeline
│   ├── shared/           # Shared types and utilities
│   └── eval/             # Extraction quality evaluation suite
├── apps/
│   ├── dashboard/        # Next.js dashboard at app.withmemory.dev
│   └── docs/             # Documentation site
├── infra/
│   └── migrations/       # Generated SQL migration files (portable)
├── supabase/             # Local Supabase CLI config
└── examples/             # Integration examples for various frameworks

Packages follow the `@withmemory/*` naming convention on npm. Apps are deployed separately. Infra and supabase are tooling.

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
- `PROD_DATABASE_URL` — only needed if you're applying migrations to production

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
4. When ready to ship: `pnpm --filter @withmemory/server deploy`
5. Commit and push

### Deploying the server
```bash
pnpm --filter @withmemory/server deploy
```

This runs `wrangler deploy`, which bundles the code and ships it to Cloudflare. The deployed Worker is at `https://api.withmemory.dev`.

## Secret management

- **`.env.local`** — local development secrets for Drizzle Kit (database URLs). Gitignored. Per-developer.
- **`.dev.vars`** — local Worker dev secrets for Wrangler. Gitignored. Per-developer.
- **`.env.example`** — template showing what variables need to be set. Committed.
- **Production Worker secrets** — set via `wrangler secret put VAR_NAME`, stored in Cloudflare's encrypted vault. Never in files.

**Never commit `.env.local` or `.dev.vars`.** They are gitignored but always double-check `git status` before committing.

## Data model

Four tables, all prefixed `wm_`:

**`wm_accounts`** — WithMemory customers (developers). One row per signup.

**`wm_api_keys`** — API keys belonging to accounts. Stores hashed keys, never plaintext. Indexed on `key_hash` for fast lookup during request authentication.

**`wm_end_users`** — The developers' end users. Identified by `external_id`, which is whatever string the developer passes as `userId`. Unique within an account.

**`wm_memories`** — The actual memories. Both explicit (via `set()`) and extracted (via `commit()`) live here, distinguished by a `source` column. Has a `vector(512)` embedding column with an HNSW index for cosine similarity search.

See `packages/server/src/db/schema.ts` for the full definitions.

## Deployment targets

- **Production API:** `https://api.withmemory.dev` → `withmemory-api` Worker
- **Production database:** Supabase project `withmemory-prod`, region us-west-1
- **Dashboard (planned):** `https://app.withmemory.dev`
- **Marketing site (planned):** `https://withmemory.dev`
- **Documentation (planned):** `https://withmemory.dev/docs` or subdomain

## What exists (end of Session 2)

- **Server routes:** `POST /v1/set`, `/v1/get`, `/v1/recall`, `/v1/remove` and `GET /v1/health` are live on `api.withmemory.dev`. Three routes (`/v1/commit`, `/v1/memories`, `/v1/memories/:id`) return 404 until Session 3. All `/v1/*` routes require Bearer token auth.
- **SDK:** `@withmemory/sdk` at `packages/sdk/` — TypeScript client with dual ESM/CJS output, zero runtime dependencies. See `packages/sdk/API.md` for the full contract.
- **Auth:** API key middleware with SHA-256 hash lookup and `last_used_at` fire-and-forget updates via `ctx.waitUntil`.
- **E2E tests:** 17 tests passing against both local and production.
- **Example:** `examples/vercel-ai-sdk/` demonstrates the SDK integration pattern with the Vercel AI SDK.

## What is NOT yet built

- `POST /v1/commit` and the LLM extraction pipeline (Session 3)
- `POST /v1/memories` and `DELETE /v1/memories/:id` (Session 3)
- Embedding generation and vector similarity search
- Deduplication and conflict resolution
- The dashboard at `app.withmemory.dev`
- Billing integration
- Open-source publication (repo goes public when server + SDK are ready)

## Further reading

- `CLAUDE.md` — Context and conventions for AI coding assistants
- `CONTRIBUTING.md` — How to contribute (placeholder until public)
- `packages/server/src/db/schema.ts` — Database schema source of truth
- `infra/migrations/` — Generated SQL migrations (portable, reviewable)
