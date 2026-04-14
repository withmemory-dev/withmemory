# WithMemory + Vercel AI SDK Example

Demonstrates the `@withmemory/sdk` integration pattern with the Vercel AI SDK in under 50 lines.

## What this demonstrates

- Configuring the SDK singleton with `memory.configure()`
- Storing explicit facts with `memory.add()` and retrieving them with `memory.get()`
- Retrieving a `context` string with `memory.recall()`
- Prepending memory context to an LLM system message via the Vercel AI SDK
- Extracting facts from a conversation turn with `memory.add()` (no `forKey`)

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
1. Adding memories...

   add name → Andrew
   add tech_stack → TypeScript, Next.js, Cloudflare Workers

2. Recalling memories...

   context:
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

5. Adding conversation for extraction...

   Extracted N memories from conversation.

Done.
```

If `OPENAI_API_KEY` is not set, step 3 prints a skip message and the example still completes successfully.
