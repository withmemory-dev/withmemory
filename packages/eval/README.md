# @withmemory/eval — Extraction Quality Eval Harness

Measures the quality of WithMemory's LLM extraction pipeline against a labeled dataset of conversation turns.

## What it measures

The harness runs the extraction library (`runExtraction` from `@withmemory/server`) against each fixture and reports:

- **empty_rate** — percentage of fixtures that produced zero extractions (hero metric, target >= 70%)
- **precision** — of all memories extracted, what fraction were expected
- **recall** — of all expected memories, what fraction were extracted
- **f1** — harmonic mean of precision and recall
- **ambiguous_agreement_rate** — how often the model chose "extract nothing" on ambiguous cases
- **adversarial_robust_rate** — how often the model correctly extracted nothing from injection attempts

## How to run

```bash
OPENAI_API_KEY=sk-... \
EXTRACTION_PROMPT_VERSION=0.1.0 \
pnpm --filter @withmemory/eval eval
```

Requires a real OpenAI API key. The extraction prompt itself is read from `packages/server/src/lib/extraction-prompt.txt` at startup — no need to pass it as an env var.

`EXTRACTION_PROMPT_VERSION` is optional and defaults to `"eval"` if not set, but passing the real version (e.g. `0.1.0`) makes the eval output directly comparable to production runs and makes metrics tables easier to read.

## Fixture format

Fixtures live in `fixtures/v1.jsonl` — one JSON object per line. The dataset contains 50 hand-curated examples across four categories (15 negative, 15 positive, 15 ambiguous, 5 adversarial). v0.1.0 of the extraction prompt was measured against this dataset with the results captured in docs/sessions/session-5-kickoff.md.

Each fixture has this schema:

```json
{
  "id": "neg-01",
  "input": "user message",
  "output": "assistant response",
  "category": "negative",
  "expected_memories": [],
  "notes": "why this fixture exists"
}
```

### The four categories

| Category | `expected_memories` | What it tests |
|---|---|---|
| **negative** | `[]` | The LLM should extract nothing. Most real traffic falls here. |
| **positive** | `["fact one", ...]` | The LLM should extract these specific facts. |
| **ambiguous** | `null` | Either 0 or 1 extractions is acceptable — a judgment call. Tracked separately, excluded from precision/recall. |
| **adversarial** | `[]` | Prompt injection or PII extraction attempts. Should produce nothing. Tracked as a robustness metric separate from normal negatives. |

### Adding fixtures

Append a new JSON line to `fixtures/v1.jsonl`. Each line is self-contained — no imports, no array syntax, clean git diffs.

```bash
echo '{"id":"neg-03","input":"...","output":"...","category":"negative","expected_memories":[],"notes":"..."}' >> fixtures/v1.jsonl
```

Use the id prefix convention: `neg-XX`, `pos-XX`, `amb-XX`, `adv-XX`.
