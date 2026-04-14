# Followups

Tracked issues and deferred work items.

---

## Drizzle Kit prod pipeline unreliable

**Logged:** April 2026

Drizzle Kit pooler pipeline unreliable. Session pooler URL (PROD_MIGRATION_URL) works for raw psql but drizzle-kit migrate silently exits code 1 without applying migration and without a clear error message. Current workaround: apply raw SQL via `psql -f infra/migrations/<file>.sql` and manually insert the `__drizzle_migrations` tracking row with the correct hash and current timestamp. To investigate: (a) confirm env var precedence between invocation-time DATABASE_URL override and .env.local fallback — Drizzle Kit may be silently hitting localhost instead of pooler; (b) rule out the bogus `__drizzle_migrations` row id=4 (hash `6fb1b7a9...`, `created_at` 1744329600000 = Apr 2025) as a potential source of confusion; (c) test session pooler vs transaction pooler vs IPv4 add-on. Until fixed, every prod migration requires the manual workaround.

---

## Commit quota is pre-check only

**Logged:** April 2026

Commit quota is pre-check-only; extraction can produce N memories per exchange. `POST /v1/commit` gates with `checkMemoryQuota(db, account, 1)` before extraction runs, because LLM extraction count is unknown until completion. A single verbose exchange from an account near its limit can produce multiple memories and transiently exceed quota by the extraction-output count minus 1. Possible fix: add a post-extraction per-memory quota check inside the `waitUntil` loop, or add a DB-level check constraint or trigger that rejects individual inserts when `wm_accounts.memory_limit` is crossed. Low priority — bounded by extraction output size, rarely hit in practice.
