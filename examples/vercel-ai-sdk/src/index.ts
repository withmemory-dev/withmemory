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

const forScope = "demo-user";
const userMessage = "What stack should I use for my new project?";

// ── Step 1: Store facts about the user ────────────────────────────────────────

console.log("\n1. Adding memories...\n");

const nameResult = await memory.add({ value: "Andrew", forKey: "name", forScope });
console.log(`   add name → ${nameResult.memories[0].value}`);

const stackResult = await memory.add({
  value: "TypeScript, Next.js, Cloudflare Workers",
  forKey: "tech_stack",
  forScope,
});
console.log(`   add tech_stack → ${stackResult.memories[0].value}`);

// ── Step 2: Recall memories with a user query ─────────────────────────────────

console.log("\n2. Recalling memories...\n");

const { context, memories } = await memory.recall({
  forScope,
  query: userMessage,
});

console.log(`   context:\n   "${context}"\n`);
console.log(`   ${memories.length} memories returned:`);
for (const m of memories) {
  console.log(`     - ${m.forKey}: ${m.value}`);
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

const nameCheck = await memory.get({ forScope, forKey: "name" });
const stackCheck = await memory.get({ forScope, forKey: "tech_stack" });
console.log(`   get name → ${nameCheck.memory?.value ?? "(not found)"}`);
console.log(`   get tech_stack → ${stackCheck.memory?.value ?? "(not found)"}`);

// ── Step 5: Store a conversation turn via extraction ─────────────────────────

console.log("\n5. Adding conversation for extraction...\n");

const reply =
  llmResponse ?? "I'd recommend sticking with your current stack since you already know it well.";

const extractionResult = await memory.add({
  forScope,
  value: `User: ${userMessage}\nAssistant: ${reply}`,
});

console.log(`   Extracted ${extractionResult.memories.length} memories from conversation.\n`);

console.log("Done.\n");
