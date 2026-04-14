import { memory } from "@withmemory/sdk";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const API_KEY = process.env.WITHMEMORY_API_KEY;
const BASE_URL = process.env.WITHMEMORY_BASE_URL;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("WITHMEMORY_API_KEY is required.");
  process.exit(1);
}

memory.configure({
  apiKey: API_KEY,
  ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
});

const userId = "demo-user";
const userMessage = "What stack should I use for my new project?";

// ── Step 1: Store facts about the user ────────────────────────────────────────

console.log("\n1. Setting memories...\n");

const nameResult = await memory.set(userId, "name", "Andrew");
console.log(`   set name → ${nameResult.memory.value}`);

const stackResult = await memory.set(
  userId,
  "tech_stack",
  "TypeScript, Next.js, Cloudflare Workers"
);
console.log(`   set tech_stack → ${stackResult.memory.value}`);

// ── Step 2: Recall memories with a user query ─────────────────────────────────

console.log("\n2. Recalling memories...\n");

const { context, memories } = await memory.recall({
  userId,
  input: userMessage,
});

console.log(`   context:\n   "${context}"\n`);
console.log(`   ${memories.length} memories returned:`);
for (const m of memories) {
  console.log(`     - ${m.key}: ${m.value}`);
}

// ── Step 3: Use context in an LLM call via Vercel AI SDK ──────────────────────

let llmResponse: string | null = null;

if (!OPENAI_KEY) {
  console.log("\n3. Set OPENAI_API_KEY to see the full AI SDK integration. Skipping LLM call.\n");
} else {
  console.log("\n3. Calling OpenAI with memory context...\n");

  const { text } = await generateText({
    model: openai("gpt-4.1-mini"),
    system: `You are a helpful assistant. Here is what you know about this user:\n${context}`,
    prompt: userMessage,
  });

  llmResponse = text;
  console.log(`   LLM response:\n   ${text}\n`);
}

// ── Step 4: Verify with get() ─────────────────────────────────────────────────

console.log("4. Verifying stored memories with get()...\n");

const nameCheck = await memory.get(userId, "name");
const stackCheck = await memory.get(userId, "tech_stack");
console.log(`   get name → ${nameCheck.memory?.value ?? "(not found)"}`);
console.log(`   get tech_stack → ${stackCheck.memory?.value ?? "(not found)"}`);

// ── Step 5: Commit the conversation for async extraction ──────────────────────

console.log("\n5. Committing conversation for async extraction...\n");

const reply =
  llmResponse ?? "I'd recommend sticking with your current stack since you already know it well.";

// await is used here for legible execution order in the example. In production,
// use `void memory.commit(...)` or `ctx.waitUntil(memory.commit(...))`.
await memory.commit({
  userId,
  input: userMessage,
  output: reply,
});

console.log("   Committed — fire-and-forget, never throws.\n");

console.log("Done.\n");
