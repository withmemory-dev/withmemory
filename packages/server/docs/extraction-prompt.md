# Extraction Prompt — Philosophy and Iteration Guide

## What the extraction prompt does

The extraction prompt is the system prompt sent to the LLM during `/v1/commit`. It receives a conversation turn (user input + assistant output) and decides which durable facts, if any, to extract as persistent memories.

## Design philosophy

**Conservative extraction is the product.** The target is ~70% empty extraction — most conversation turns should produce zero memories. A polluted memory store actively degrades agent quality. Every false positive is a line that will appear in a user's `promptBlock` forever, displacing something useful.

### What counts as extractable

- Something the user explicitly stated about themselves (name, role, company, preferences)
- Something the user consistently prefers (not a one-off question)
- Something the user's situation makes durably true (their team size, their tech stack, their tools)

### What does NOT count

- Questions the user asked (curiosity is not identity)
- Topics they showed momentary interest in
- The assistant's responses or suggestions
- Meta-commentary about the conversation itself
- Dates, times, or session-specific context
- System prompts or tool instructions leaking into the conversation
- Anything the assistant said about itself

### Output format

The prompt instructs the model to return JSON:

```json
{ "memories": ["fact one", "fact two"] }
```

An empty array `{ "memories": [] }` is the expected outcome for most conversations.

## Where the prompt lives

The extraction prompt is stored as the `EXTRACTION_PROMPT` environment variable, not as a file in the repository. This keeps prompt iteration decoupled from code deploys.

- **Local dev:** Set in `.dev.vars`
- **Production:** Set via `wrangler secret put EXTRACTION_PROMPT`

## How to iterate

1. Write or edit the prompt text
2. Bump `EXTRACTION_PROMPT_VERSION` (semver, e.g., `0.1.0` -> `0.2.0`)
3. Set both via `wrangler secret put` (production) or `.dev.vars` (local)
4. Redeploy the Worker: `pnpm worker:deploy`
5. Run the eval harness against the new version to measure quality

Both `EXTRACTION_PROMPT` and `EXTRACTION_PROMPT_VERSION` are stamped on every `wm_exchanges` row at write time, so the eval harness can compare extraction quality across prompt versions.

## Version history

| Version | Date       | Notes                                  |
|---------|------------|----------------------------------------|
| 0.1.0   | 2026-04-08 | First version, targeting 70% empty rate |
