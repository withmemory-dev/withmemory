# CLAUDE.md — Context for AI Coding Assistants

This file is the primary orientation document for AI assistants working on WithMemory. Read it before making any code changes. It captures the technical decisions and working conventions that aren't obvious from the code alone.

## The product in one paragraph

WithMemory is a persistent memory layer for AI agents. Developers integrate it with two API calls: `memory.add({ forScope, value })` to store facts (optionally with an explicit `forKey` to bypass LLM extraction), and `memory.recall({ forScope, query })` to retrieve a prompt-ready context block before every LLM invocation. The output of `recall()` is a rigid contract: a `context` string under 150 tokens containing at most 4 items, safe to prepend to any system prompt. WithMemory is configuration-free by default, TypeScript-native, and self-hostable on any Postgres database.

## Design principles

Every technical decision should preserve two properties: (1) zero configuration for the developer, (2) portability across Postgres providers. If a change would require a developer to set thresholds, pick embedding models, or configure retrieval, it is probably wrong. If a change would couple the server to Supabase-specific features, it is wrong.

## Licensing

The SDK (`packages/sdk`) is Apache 2.0. The server (`packages/server`) is BUSL 1.1, converting to Apache 2.0 after four years.

## Architecture at a glance

**Runtime:** Cloudflare Workers via Hono. Hono runs identically on Workers, Node, Bun, and Deno, so the same server code can run as a Docker container for self-hosters.

**Database:** PostgreSQL with pgvector. Hosted version uses Supabase. Self-hosted can use any Postgres provider.

**Query layer:** Drizzle ORM with the `postgres` driver (postgres-js). Drizzle provides type safety and portability. The `postgres` driver provides serverless compatibility and Supabase pooler support.

**Schema location:** `packages/server/src/db/schema.ts` is the source of truth for the database schema. All tables, columns, constraints, and indexes are defined here in TypeScript. Migrations are generated from this file via `pnpm db:generate`.

**Connection pattern:** The `createDb(url)` factory in `packages/server/src/db/client.ts` takes a URL and returns a Drizzle client. The module never reads from `process.env` or Worker bindings directly — the caller is responsible for providing the URL. This keeps the database client runtime-agnostic.

**Migration pattern:** Drizzle Kit generates plain SQL files in `infra/migrations/`. These files are portable — any Postgres migration runner can apply them. We manually add `CREATE EXTENSION vector` at the top of the initial migration and HNSW index creation at the bottom because Drizzle Kit does not generate these.

## Non-negotiable conventions

These are rules that should not be changed without an explicit architectural discussion.

**No Supabase-specific code in the server.** The server must work against vanilla Postgres. Do not import from `@supabase/supabase-js`. Do not use PostgREST. Do not use Supabase Auth in the server — API key authentication is custom via the `wm_api_keys` table.

**No `process.env` in the database client.** The `createDb` function takes a URL parameter. If you need to read from env, read it in the route handler and pass the URL in.

**No runtime-specific code in `packages/server/src/db/`.** The database layer must work identically in Workers, Node, and Bun. Runtime-specific glue lives in route handlers or dedicated adapter files.

**Migrations are plain SQL and always reviewed before applying.** Never run `drizzle-kit push` (which bypasses migration files) against production. The workflow is always: edit schema, generate migration, read the SQL, apply locally, test, apply to production.

**Secrets never live in code or in committed files.** Local dev secrets go in `.env.local` and `.dev.vars` (both gitignored). Production secrets go in Cloudflare Worker environment via `wrangler secret put`. The `.env.example` file shows the shape without real values.

**The recall output contract is rigid.** `context` is always a string, always under 150 tokens, always contains at most 4 items. Do not add optional fields, do not make the length configurable, do not return null. Breaking this contract is worse than keeping it imperfect.

**Extraction is conservative.** The extraction prompt is designed to produce empty results from the majority of conversation turns. A polluted memory store actively degrades agent quality. When in doubt, extract nothing.

**TypeScript strict mode everywhere.** No `any`, no `@ts-ignore` without a comment explaining why, no implicit any.

## Code style conventions

**Formatting:** Prettier with the default config plus `printWidth: 100`. Run `pnpm format` before committing. VS Code with the Prettier extension handles this on save.

**Imports:** Absolute imports are not used — relative imports only within a package, `@withmemory/shared` style for cross-package imports (once shared package exists).

**Naming:**
- Database tables: `wm_*` prefix, snake_case (e.g., `wm_memories`)
- Drizzle schema exports: camelCase (e.g., `wmMemories`)
- TypeScript types: PascalCase (e.g., `WmMemory`, `NewWmMemory`)
- Route files: kebab-case (e.g., `api-keys.ts`)
- SDK methods: camelCase, verb-first (e.g., `add`, `recall`, `get`, `remove`)

**File organization:**
- Route handlers go in `packages/server/src/routes/` (once created)
- Database utilities go in `packages/server/src/db/`
- Middleware goes in `packages/server/src/middleware/`
- Shared types go in `packages/shared/src/types/`

**Error handling:** Routes should return JSON errors with appropriate HTTP status codes. Never throw unhandled errors from a route. Never return 500 without logging the underlying error.

**Comments:** Comments should explain *why*, not *what*. If the code is doing something non-obvious (e.g., `prepare: false` for pooler compatibility), explain the reason. Otherwise let the code speak for itself.

## What lives where
packages/server/
├── src/
│   ├── index.ts              # Hono app entry, route registration
│   ├── types.ts              # WorkerEnv and AppVariables types
│   ├── db/
│   │   ├── schema.ts         # SOURCE OF TRUTH for the database schema
│   │   └── client.ts         # createDb() factory, runtime-agnostic
│   ├── routes/v1/
│   │   ├── index.ts          # v1 route aggregator + catch-all 404
│   │   ├── add.ts            # POST /v1/memories (explicit + extraction)
│   │   ├── get.ts            # POST /v1/memories/get
│   │   ├── recall.ts         # POST /v1/recall (with defaults support)
│   │   ├── remove.ts         # POST /v1/memories/remove
│   │   ├── memories.ts       # POST /v1/memories/list + DELETE /v1/memories/:id
│   │   ├── health.ts         # GET /v1/health
│   │   └── account.ts        # POST/GET/DELETE /v1/account/extraction-prompt
│   ├── middleware/
│   │   └── auth.ts           # API key auth (SHA-256, Bearer token)
│   └── lib/
│       ├── hash.ts           # SHA-256 Web Crypto helper
│       ├── end-users.ts      # ensureEndUser() shared upsert helper
│       ├── extraction.ts     # LLM extraction + embedding via OpenAI
│       ├── add-with-extraction.ts # Extraction pipeline helper for add route
│       ├── extraction-prompt.txt  # Bundled extraction prompt (text module)
│       └── text-modules.d.ts # TypeScript declaration for .txt imports
├── docs/
│   └── extraction-prompt.md  # Extraction prompt philosophy and iteration guide
├── drizzle.config.ts         # Local Drizzle Kit config (reads DATABASE_URL)
├── drizzle.config.prod.ts    # Production config (reads PROD_DATABASE_URL, throws if missing)
├── wrangler.toml             # Cloudflare Worker config
├── package.json
├── tsconfig.json
├── .env.example              # Template, committed
├── .env.local                # GITIGNORED, developer-specific
└── .dev.vars                 # GITIGNORED, Wrangler local secrets
packages/eval/
├── fixtures/
│   └── v1.jsonl              # Labeled extraction test cases (JSONL, four-category)
├── src/
│   ├── types.ts              # Fixture and FixtureCategory types
│   └── run.ts                # Eval harness runner
├── README.md                 # How to run and add fixtures
├── package.json
└── tsconfig.json
infra/
└── migrations/               # Generated SQL migrations (portable)
├── 0000_pink_red_wolf.sql
├── 0001_funny_joystick.sql
├── 0002_shallow_risque.sql
└── meta/                 # Drizzle Kit state snapshots
supabase/
├── config.toml               # Local Supabase CLI config
└── .gitignore                # Excludes .temp and .branches

## Commands cheat sheet

From the project root:
```bash
pnpm install                                    # Install all workspace deps
supabase start                                  # Start local Postgres + Studio
supabase stop                                   # Stop local Supabase
```

From `packages/server/` (or using `pnpm --filter @withmemory/server <command>`):
```bash
pnpm dev                                        # Local Worker dev server (port 8787)
pnpm deploy                                     # Deploy to Cloudflare production
pnpm typecheck                                  # Run tsc --noEmit
pnpm db:generate                                # Generate a new migration from schema changes
pnpm db:migrate                                 # Apply migrations to local database
pnpm db:migrate:prod                            # Apply migrations to production
pnpm db:studio                                  # Launch Drizzle Studio (local web UI)
```

## Things to watch out for

**Wrangler local dev needs `127.0.0.1`, not `host.docker.internal`** — Wrangler 4.x runs workerd as a native macOS process, not in a Docker container, so Docker-specific hostnames do not resolve. Use `127.0.0.1:54322` for local Postgres in `.dev.vars`.

**The Supabase transaction pooler does not support prepared statements** — when connecting to production Postgres via the pooler (port 6543), the `postgres-js` client must have `prepare: false`. This is set in `createDb()` and should not be removed.

**Do not use the pooler for migrations** — Drizzle Kit migrations need a direct connection (port 5432), not the pooler. The pooler is for runtime queries from serverless workers.

**pgvector must be enabled before any table uses `vector()` columns** — the `CREATE EXTENSION` statement must run before table creation. It's at the top of the initial migration.

**Drizzle Kit does not generate HNSW index syntax** — the HNSW index on `wm_memories.embedding` must be added manually at the bottom of the migration file. Use `vector_cosine_ops` for cosine similarity, which matches OpenAI embeddings.

**Do not reference `[YOUR-PASSWORD]` literally in any connection string** — Supabase's dashboard shows placeholder text that must be replaced with the real password before use.

**Drizzle's custom vector type uses 512 dimensions, not 1536** — we use Matryoshka truncation of OpenAI's `text-embedding-3-small` to cut storage in half while retaining ~97% of quality. Do not change this without considering the storage implications.

## Current state (April 2026)

The server API, TypeScript SDK, and extraction pipeline are functional. All `/v1/*` routes are live.

What exists:
- Monorepo structure with pnpm workspaces
- `packages/server` with Hono, Drizzle, API key auth middleware, and live `/v1/*` routes (`memories` (add), `memories/get`, `memories/remove`, `memories/list`, `memories/:id`, `recall`, `health`, `account/extraction-prompt` POST/GET/DELETE). A catch-all 404 handler on the v1 sub-app returns the standard `{ error: { code, message } }` envelope for unknown routes.
- `packages/sdk` (`@withmemory/sdk`) — TypeScript SDK with dual ESM/CJS output via tsup, zero runtime dependencies. Exports a `memory` singleton and a `createClient()` factory. Core methods: `add` (explicit + extraction), `get`, `recall`, `remove`, `list`, `deleteMemory`, `health`, plus extraction prompt CRUD and containers namespace. `register()` stores defaults and forwards them to `recall()`. See `packages/sdk/API.md` for the canonical contract.
- Database schema for five tables (`wm_accounts`, `wm_api_keys`, `wm_end_users`, `wm_exchanges`, `wm_memories`) applied to local. `wm_accounts.extraction_prompt` (nullable text) supports customer-configurable extraction prompts.
- `wm_exchanges` table stores extraction audit trail for `add()` calls without `forKey`
- `wm_memories.exchange_id` FK links extracted memories to their source exchange
- LLM extraction library (`packages/server/src/lib/extraction.ts`) using direct OpenAI fetch (gpt-4.1-mini for extraction, text-embedding-3-small at 512 dimensions for embeddings)
- `POST /v1/memories` handles both explicit writes (with `forKey`) and synchronous extraction (without `forKey`), supports Idempotency-Key header on extraction path
- `register()` defaults wired through `recall()` as tier 4 fallback — appears in `context` only, not in the `memories` array
- `WorkerEnv` type centralized in `packages/server/src/types.ts` — all env vars declared once
- `ensureEndUser()` helper shared across `set.ts` and `commit.ts`
- API key authentication middleware (SHA-256 hash, Bearer token, `last_used_at` updated via `ctx.waitUntil`)
- E2E test suite covering all routes plus auth, validation, idempotency, extraction, defaults, SDK register() → recall() flow, extraction prompt CRUD, and cross-account ownership — passing against local
- `packages/eval/` — extraction eval harness with 12 labeled fixtures and quality scoring
- `examples/vercel-ai-sdk/` — integration example demonstrating set → recall → LLM call → commit against `api.withmemory.dev`
- Local development environment via Supabase CLI + Docker
- Production deployment pipeline via Wrangler (`pnpm worker:deploy`)
- Secret management via `.env.local` and `.dev.vars`
- Git repository at `github.com/withmemory-dev/withmemory` (private)

This repo contains the SDK and server. The dashboard, billing, and documentation site live in separate repositories.

## How to contribute effectively

When making changes, prefer small focused commits over large ones. Each commit should be reviewable in isolation. Commit messages should explain *why* the change was made, not just *what* changed.

Before committing:
1. Run `pnpm typecheck` to catch type errors
2. Run `pnpm format` to apply Prettier
3. Verify `git status` does not show any secrets files as staged
4. Write a clear commit message

When adding new routes or features:
1. Think about whether the change preserves the zero-configuration principle
2. Think about whether the change preserves Postgres portability
3. Update `SETUP.md` if the development workflow changes
4. Update `CLAUDE.md` if the conventions or architecture change

When touching the database schema:
1. Edit `packages/server/src/db/schema.ts`
2. Run `pnpm db:generate`
3. Read the generated SQL carefully
4. Apply to local: `pnpm db:migrate`
5. Verify in Supabase Studio at http://localhost:54323
6. Apply to production: `pnpm db:migrate:prod`
7. Commit the schema change and the migration together

## Repository hygiene

This repo is built as if fully open — every file should be appropriate for a public repository.

**Keep the repo technical.** Do not commit business framing, competitor references, or internal planning documents. The repo documents what the SDK and server do and how to use them.

**Never commit secrets.** No API keys, passwords, or tokens in code, comments, commit messages, or test fixtures. Real values go in `.env.local`, `.dev.vars`, or `wrangler secret put`.

**The extraction prompt is committed to the repo.** The prompt lives at `packages/server/src/lib/extraction-prompt.txt` and is imported at build time as a text module. The `EXTRACTION_PROMPT_VERSION` env var (set via `wrangler secret put`) stamps each extraction with the version of the prompt that produced it, which is written to `wm_exchanges.prompt_version` for every commit. Iterating the prompt means editing the `.txt` file, bumping `EXTRACTION_PROMPT_VERSION` in both `.dev.vars` and the production secret, and committing + deploying. The philosophy and iteration guide live in `packages/server/docs/extraction-prompt.md`.

When in doubt, leave it out. If something would be surprising or inappropriate in a public clone, it doesn't belong.

## Reference files

- `SETUP.md` — Human-readable setup guide
- `CONTRIBUTING.md` — How to contribute (placeholder)
- `packages/server/src/db/schema.ts` — Database schema (5 tables)
- `packages/server/src/db/client.ts` — Database connection factory
- `packages/server/src/types.ts` — WorkerEnv and AppVariables types
- `packages/server/src/index.ts` — Hono server entry point
- `packages/server/src/lib/extraction.ts` — LLM extraction and embedding library
- `packages/server/src/lib/end-users.ts` — Shared end-user upsert helper
- `packages/server/docs/extraction-prompt.md` — Extraction prompt iteration guide
- `packages/server/wrangler.toml` — Worker configuration
- `packages/sdk/API.md` — Canonical SDK contract reference
- `packages/eval/` — Extraction quality eval harness
- `infra/migrations/` — Generated SQL migrations
