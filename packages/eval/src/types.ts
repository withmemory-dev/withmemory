export type FixtureCategory = "negative" | "positive" | "ambiguous" | "adversarial";

export interface Fixture {
  id: string;
  input: string;
  output: string;
  category: FixtureCategory;
  expected_memories: string[] | null;
  notes: string;
}
