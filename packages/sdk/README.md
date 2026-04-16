# @withmemory/sdk

TypeScript SDK for the WithMemory API. Provides persistent memory for AI agents with zero configuration.

## Installation

```bash
pnpm add @withmemory/sdk
# or
npm install @withmemory/sdk
# or
yarn add @withmemory/sdk
```

## Quick start

```ts
import { memory } from "@withmemory/sdk";

memory.configure({ apiKey: "wm_..." });

// Store a fact
await memory.add({
  value: "Prefers dark mode",
  key: "ui_preference",
  scope: "user_123"
});

// Recall context for an LLM call
const { context } = await memory.recall({
  scope: "user_123",
  query: "What does the user prefer?"
});

// context is a string ready to prepend to any system prompt
```

For multi-tenant apps, use `createClient()` instead of the singleton:

```ts
import { createClient } from "@withmemory/sdk";
const client = createClient({ apiKey: "wm_..." });
```

## API reference

See [API.md](./API.md) for the full type definitions, method signatures, error codes, and response shapes.

## License

Apache 2.0
