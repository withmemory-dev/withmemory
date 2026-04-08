# WithMemory + Vercel AI SDK Example

Demonstrates the `@withmemory/sdk` integration pattern with the Vercel AI SDK in under 50 lines.

## What this demonstrates

- Configuring the SDK singleton with `memory.configure()`
- Storing explicit facts with `memory.set()` and retrieving them with `memory.get()`
- Retrieving a prompt-ready `promptBlock` with `memory.recall()`
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

   promptBlock:
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

## About the commit() warning

You'll see a warning line in the output like:

```
[@withmemory/sdk] commit() failed silently: Route not found
```

This is expected for now. `commit()` posts to `/v1/commit`, which lands in Session 3 along with the extraction pipeline. The warning demonstrates the fire-and-forget contract in action: `commit()` never throws, even when the route doesn't exist yet. When the server route ships, the warning disappears and the example keeps working without code changes.
