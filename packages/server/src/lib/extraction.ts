import { embedTexts } from "./embeddings";

/**
 * LLM extraction and embedding generation via direct OpenAI API calls.
 *
 * This module is the shared core imported by both the add route and the eval
 * harness. It never touches the database — callers are responsible for
 * persisting results.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtractedMemory {
  content: string;
  embedding: number[] | null;
}

export interface ExtractionResult {
  memories: ExtractedMemory[];
  promptVersion: string;
  error: string | null;
}

// ─── Extraction ──────────────────────────────────────────────────────────────

export async function runExtraction(params: {
  openaiApiKey: string;
  prompt: string;
  promptVersion: string;
  input: string;
}): Promise<ExtractionResult> {
  const { openaiApiKey, prompt, promptVersion, input } = params;

  // Step 1: Extract memories via gpt-4.1-mini
  let rawMemories: string[];
  try {
    rawMemories = await callExtraction(openaiApiKey, prompt, input);
  } catch (err) {
    return {
      memories: [],
      promptVersion,
      error: err instanceof Error ? err.message : "extraction_failed",
    };
  }

  if (rawMemories.length === 0) {
    return { memories: [], promptVersion, error: null };
  }

  // Step 2: Generate embeddings for all extracted memories in one batch
  let embeddings: (number[] | null)[];
  try {
    embeddings = await embedTexts(openaiApiKey, rawMemories);
  } catch (err) {
    // Extraction succeeded but embedding failed — return memories without vectors
    return {
      memories: rawMemories.map((content) => ({ content, embedding: null })),
      promptVersion,
      error: "embedding_failed",
    };
  }

  return {
    memories: rawMemories.map((content, i) => ({
      content,
      embedding: embeddings[i] ?? null,
    })),
    promptVersion,
    error: null,
  };
}

// ─── OpenAI Chat Completions ─────────────────────────────────────────────────

async function callExtraction(
  apiKey: string,
  systemPrompt: string,
  input: string
): Promise<string[]> {
  const userMessage = input;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI extraction API returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const raw = body.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("OpenAI extraction returned empty content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI extraction returned invalid JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("memories" in parsed) ||
    !Array.isArray((parsed as { memories: unknown }).memories)
  ) {
    throw new Error("OpenAI extraction response missing memories array");
  }

  const memories = (parsed as { memories: unknown[] }).memories;

  // Filter to strings only, ignore anything else
  return memories.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse EXTRACTION_MAX_INPUT_BYTES from the env var string.
 * Returns the parsed number, or 16384 (16KB) as default.
 */
export function parseMaxInputBytes(raw: string | undefined): number {
  if (!raw) return 16384;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16384;
}
