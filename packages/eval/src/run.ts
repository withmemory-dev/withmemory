/**
 * Extraction eval harness.
 *
 * Runs the extraction library against labeled JSONL fixtures and reports
 * quality metrics across four categories: negative, positive, ambiguous,
 * and adversarial.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... pnpm --filter @withmemory/eval eval
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runExtraction } from "@withmemory/server/src/lib/extraction";
import type { Fixture, FixtureCategory } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXTRACTION_PROMPT_VERSION = process.env.EXTRACTION_PROMPT_VERSION ?? "eval";

if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is required.");
  process.exit(1);
}

// ─── Load fixtures ───────────────────────────────────────────────────────────

function loadFixtures(path: string): Fixture[] {
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("//"))
    .map((line, i) => {
      try {
        return JSON.parse(line) as Fixture;
      } catch {
        throw new Error(`Failed to parse fixture at line ${i + 1}: ${line.slice(0, 80)}`);
      }
    });
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

interface EvalResult {
  fixture: Fixture;
  extractedMemories: string[];
  error: string | null;
  correct: boolean;
}

async function evaluateFixture(fixture: Fixture): Promise<EvalResult> {
  const result = await runExtraction({
    openaiApiKey: OPENAI_API_KEY!,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    input: { input: fixture.input, output: fixture.output },
  });

  if (result.error && result.memories.length === 0) {
    return { fixture, extractedMemories: [], error: result.error, correct: false };
  }

  const extracted = result.memories.map((m) => m.content);
  const expected = fixture.expected_memories;

  let correct: boolean;
  if (expected === null) {
    // Ambiguous: either outcome is acceptable, but we track agreement
    correct = true;
  } else if (expected.length === 0) {
    correct = extracted.length === 0;
  } else {
    // Positive: got at least as many as expected
    correct = extracted.length >= expected.length;
  }

  return { fixture, extractedMemories: extracted, error: result.error, correct };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

async function main() {
  const fixturesPath = resolve(__dirname, "../fixtures/v1.jsonl");
  const fixtures = loadFixtures(fixturesPath);

  console.log(`\nWithMemory Extraction Eval Harness`);
  console.log(`Prompt version: ${EXTRACTION_PROMPT_VERSION}`);
  console.log(`Fixtures: ${fixtures.length}\n`);

  const start = performance.now();
  const results: EvalResult[] = [];

  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture);
    results.push(result);

    const icon = result.error ? "!" : result.correct ? "\u2713" : "\u2717";
    console.log(`${icon} [${fixture.category}] ${fixture.id}: ${fixture.notes}`);
    if (result.extractedMemories.length > 0) {
      for (const m of result.extractedMemories) {
        console.log(`    -> ${m}`);
      }
    }
    if (result.error) {
      console.log(`    error: ${result.error}`);
    }
  }

  const durationMs = Math.round(performance.now() - start);

  // ── Compute metrics ──────────────────────────────────────────────────────

  const byCategory = (cat: FixtureCategory) => results.filter((r) => r.fixture.category === cat);

  // Empty rate across ALL categories (the hero metric)
  const totalEmpty = results.filter((r) => r.extractedMemories.length === 0).length;
  const emptyRate = results.length > 0 ? totalEmpty / results.length : 0;

  // Precision / recall across negative + positive + adversarial (not ambiguous)
  const scored = results.filter((r) => r.fixture.category !== "ambiguous");
  const truePositives = scored.filter(
    (r) =>
      r.fixture.expected_memories !== null &&
      r.fixture.expected_memories.length > 0 &&
      r.extractedMemories.length > 0
  ).length;
  const falsePositives = scored.filter(
    (r) =>
      r.fixture.expected_memories !== null &&
      r.fixture.expected_memories.length === 0 &&
      r.extractedMemories.length > 0
  ).length;
  const falseNegatives = scored.filter(
    (r) =>
      r.fixture.expected_memories !== null &&
      r.fixture.expected_memories.length > 0 &&
      r.extractedMemories.length === 0
  ).length;

  const precision =
    truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
  const recall =
    truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // Ambiguous agreement rate
  const ambiguous = byCategory("ambiguous");
  const ambiguousAgreement = ambiguous.filter((r) => r.extractedMemories.length === 0).length;
  const ambiguousRate = ambiguous.length > 0 ? ambiguousAgreement / ambiguous.length : 0;

  // Adversarial robustness rate
  const adversarial = byCategory("adversarial");
  const adversarialRobust = adversarial.filter((r) => r.extractedMemories.length === 0).length;
  const adversarialRate = adversarial.length > 0 ? adversarialRobust / adversarial.length : 0;

  // ── Report ───────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  empty_rate:                ${(emptyRate * 100).toFixed(1)}%  (target: >=70%)`);
  console.log(`  precision:                 ${(precision * 100).toFixed(1)}%`);
  console.log(`  recall:                    ${(recall * 100).toFixed(1)}%`);
  console.log(`  f1:                        ${(f1 * 100).toFixed(1)}%`);
  console.log(
    `  ambiguous_agreement_rate:  ${ambiguous.length > 0 ? (ambiguousRate * 100).toFixed(1) + "%" : "N/A (no ambiguous fixtures)"}`
  );
  console.log(
    `  adversarial_robust_rate:   ${adversarial.length > 0 ? (adversarialRate * 100).toFixed(1) + "%" : "N/A (no adversarial fixtures)"}`
  );

  console.log(`\n  Per-category breakdown:`);
  for (const cat of ["negative", "positive", "ambiguous", "adversarial"] as FixtureCategory[]) {
    const catResults = byCategory(cat);
    if (catResults.length === 0) continue;
    const correct = catResults.filter((r) => r.correct).length;
    console.log(`    ${cat}: ${correct}/${catResults.length} correct`);
  }

  console.log(`\n  prompt_version:    ${EXTRACTION_PROMPT_VERSION}`);
  console.log(`  total_duration_ms: ${durationMs}`);
  console.log(`${"=".repeat(60)}`);

  // ── List failures ────────────────────────────────────────────────────────

  const failures = results.filter((r) => !r.correct || r.error);
  if (failures.length > 0) {
    console.log(`\n  Failed cases:`);
    for (const f of failures) {
      console.log(`\n    ${f.fixture.id} [${f.fixture.category}]`);
      console.log(`      expected: ${JSON.stringify(f.fixture.expected_memories)}`);
      console.log(`      actual:   ${JSON.stringify(f.extractedMemories)}`);
      if (f.error) console.log(`      error:    ${f.error}`);
    }
  }

  console.log("");

  // Exit with failure if false positive rate exceeds threshold
  const negativeFixtures = byCategory("negative").length + byCategory("adversarial").length;
  if (negativeFixtures > 0 && falsePositives / negativeFixtures > 0.3) {
    console.error("FAIL: False positive rate exceeds 30% threshold");
    process.exit(1);
  }
}

main();
