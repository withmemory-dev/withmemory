/**
 * Extraction eval harness.
 *
 * Runs the extraction library against labeled fixtures and reports quality metrics.
 * Requires OPENAI_API_KEY and EXTRACTION_PROMPT env vars.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... EXTRACTION_PROMPT="..." pnpm --filter @withmemory/eval eval
 */

import { runExtraction } from "@withmemory/server/src/lib/extraction";
import { fixtures, type EvalFixture } from "./fixtures";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXTRACTION_PROMPT = process.env.EXTRACTION_PROMPT;
const EXTRACTION_PROMPT_VERSION = process.env.EXTRACTION_PROMPT_VERSION ?? "eval";

if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is required.");
  process.exit(1);
}
if (!EXTRACTION_PROMPT) {
  console.error("ERROR: EXTRACTION_PROMPT is required.");
  process.exit(1);
}

interface EvalResult {
  fixture: EvalFixture;
  extractedMemories: string[];
  error: string | null;
  verdict: "true_empty" | "false_positive" | "true_extraction" | "false_negative" | "partial" | "error";
}

async function evaluateFixture(fixture: EvalFixture): Promise<EvalResult> {
  const result = await runExtraction({
    openaiApiKey: OPENAI_API_KEY!,
    prompt: EXTRACTION_PROMPT!,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    input: { input: fixture.input, output: fixture.output },
  });

  if (result.error && result.memories.length === 0) {
    return {
      fixture,
      extractedMemories: [],
      error: result.error,
      verdict: "error",
    };
  }

  const extracted = result.memories.map((m) => m.content);
  const expectedEmpty = fixture.expectedMemories.length === 0;
  const gotEmpty = extracted.length === 0;

  let verdict: EvalResult["verdict"];
  if (expectedEmpty && gotEmpty) {
    verdict = "true_empty";
  } else if (expectedEmpty && !gotEmpty) {
    verdict = "false_positive";
  } else if (!expectedEmpty && gotEmpty) {
    verdict = "false_negative";
  } else {
    // Both non-empty — check if extracted covers expected
    verdict = "true_extraction";
    // Simple heuristic: if we got at least as many as expected, call it true_extraction.
    // A more sophisticated scorer would do semantic similarity matching.
    if (extracted.length < fixture.expectedMemories.length) {
      verdict = "partial";
    }
  }

  return { fixture, extractedMemories: extracted, error: result.error, verdict };
}

async function main() {
  console.log(`\nWithMemory Extraction Eval Harness`);
  console.log(`Prompt version: ${EXTRACTION_PROMPT_VERSION}`);
  console.log(`Fixtures: ${fixtures.length}\n`);

  const results: EvalResult[] = [];

  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture);
    results.push(result);

    const icon =
      result.verdict === "true_empty" || result.verdict === "true_extraction"
        ? "\u2713"
        : result.verdict === "error"
          ? "!"
          : "\u2717";

    console.log(`${icon} [${result.verdict}] ${fixture.name}`);
    if (result.extractedMemories.length > 0) {
      for (const m of result.extractedMemories) {
        console.log(`    -> ${m}`);
      }
    }
    if (result.error) {
      console.log(`    error: ${result.error}`);
    }
  }

  // Summary
  const counts = {
    true_empty: 0,
    false_positive: 0,
    true_extraction: 0,
    false_negative: 0,
    partial: 0,
    error: 0,
  };
  for (const r of results) {
    counts[r.verdict]++;
  }

  const emptyFixtures = fixtures.filter((f) => f.expectedMemories.length === 0).length;
  const extractFixtures = fixtures.length - emptyFixtures;
  const emptyRate =
    emptyFixtures > 0
      ? ((counts.true_empty / emptyFixtures) * 100).toFixed(1)
      : "N/A";
  const extractRate =
    extractFixtures > 0
      ? (((counts.true_extraction + counts.partial) / extractFixtures) * 100).toFixed(1)
      : "N/A";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results:`);
  console.log(`    True empty (correct suppression): ${counts.true_empty}/${emptyFixtures} (${emptyRate}%)`);
  console.log(`    False positive (junk extraction):  ${counts.false_positive}`);
  console.log(`    True extraction:                   ${counts.true_extraction}`);
  console.log(`    Partial extraction:                ${counts.partial}`);
  console.log(`    False negative (missed facts):     ${counts.false_negative}`);
  console.log(`    Errors:                            ${counts.error}`);
  console.log(`\n  Target: >=70% empty rate on empty fixtures`);
  console.log(`  Actual empty rate: ${emptyRate}%`);
  console.log(`  Extraction success rate: ${extractRate}%`);
  console.log(`${"=".repeat(60)}\n`);

  // Exit with failure if false positive rate is too high
  const falsePositiveRate = emptyFixtures > 0 ? counts.false_positive / emptyFixtures : 0;
  if (falsePositiveRate > 0.3) {
    console.error("FAIL: False positive rate exceeds 30% threshold");
    process.exit(1);
  }
}

main();
