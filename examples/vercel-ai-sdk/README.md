# WithMemory + Vercel AI SDK Example

Demonstrates the `@withmemory/sdk` integration pattern with the Vercel AI SDK in under 50 lines.

## What this demonstrates

- Configuring the SDK singleton with `memory.configure()`
- Storing explicit facts with `memory.set()` and retrieving them with `memory.get()`
- Retrieving a `memoryBlock` with `memory.recall()`
- Prepending memory context to an LLM system message via the Vercel AI SDK
- Fire-and-forget conversation commit with `memory.commit()`

## How to run

From the repo root:

```bash
pnpm install

# Required — your WithMemory API key
export WITHMEMORY_API_KEY=wm_...

# Optional — enables the LLM call (step 3)
export OPENAI_API_KEY=sk-...

# Optional — defaults to https://api.withmemory.dev
# To run against local: export WITHMEMORY_BASE_URL=http://localhost:8787

pnpm --filter @withmemory/example-vercel-ai-sdk start
```

## Expected output

```
1. Setting memories...

   set name → Andrew
   set tech_stack → TypeScript, Next.js, Cloudflare Workers

2. Recalling memories...

   memoryBlock:
   "tech_stack: TypeScript, Next.js, Cloudflare Workers
   name: Andrew"

   2 memories returned:
     - tech_stack: TypeScript, Next.js, Cloudflare Workers
     - name: Andrew

3. Calling OpenAI with memory context...

   LLM response:
   [A response referencing TypeScript, Next.js, and Cloudflare Workers]

4. Verifying stored memories with get()...

   get name → Andrew
   get tech_stack → TypeScript, Next.js, Cloudflare Workers

5. Committing conversation for async extraction...

   Committed — fire-and-forget, never throws.

Done.
```

If `OPENAI_API_KEY` is not set, step 3 prints a skip message and the example still completes successfully.

## About the commit() contract

`commit()` is fire-and-forget: it posts to `/v1/commit`, returns 202 immediately, and never throws. Extraction runs asynchronously on the server. If the endpoint is unreachable, you'll see a warning like `[@withmemory/sdk] commit() failed silently: ...` — the example still completes successfully.
