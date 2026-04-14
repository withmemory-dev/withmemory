# WithMemory plain TypeScript examples

This directory contains end-to-end test files that double as runnable examples of the WithMemory SDK.

## Files

- **`test-add-recall.ts`** — exercises the core memory operations: `add`, `get`, `recall`, `remove`, `list`, and the extraction path. Used as the main E2E test suite.
- **`test-containers.ts`** — exercises the agent self-service container namespace: creating containers, minting scoped keys, quota inheritance, and soft revocation.

## Running the tests

Both files are plain TypeScript scripts runnable via `tsx`:

```bash
WITHMEMORY_API_KEY="wm_..." \
WITHMEMORY_BASE_URL="http://localhost:8787" \
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
tsx test-add-recall.ts

WITHMEMORY_API_KEY="wm_..." \
WITHMEMORY_API_KEY_B="wm_..." \
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
tsx test-containers.ts
```

The main suite is also runnable via `pnpm test:e2e` from the repo root.

## Why plain TypeScript?

These files use zero testing framework dependencies — no vitest, no jest, no chai. Assertions are plain `if (condition) throw new Error(...)` statements. This keeps the test surface portable: anyone reading the SDK can copy snippets out of these files and run them directly without installing a test runner.
