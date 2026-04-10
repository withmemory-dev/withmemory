export type RecallFixture = {
  id: string;
  description: string;
  tags?: string[];
  corpus: {
    content: string;
    source: "explicit" | "extracted";
    key?: string | null;
    importance?: number;
    daysOld: number;
  }[];
  query: string;
  expected: {
    mustInclude: number[];
    mustExclude?: number[];
    topK?: number;
  };
};

export const recallEvalFixtures: RecallFixture[] = [
  // ---------------------------------------------------------------------------
  // PURE SEMANTIC RECALL (10)
  // ---------------------------------------------------------------------------

  {
    id: "recall-001",
    description: "Surface pasta-related memories for dinner planning",
    tags: ["semantic"],
    corpus: [
      { content: "User loves spaghetti carbonara.", source: "extracted", daysOld: 7 },
      { content: "User dislikes mushrooms on pizza.", source: "extracted", daysOld: 12 },
      { content: "User usually cooks pasta on Sundays.", source: "extracted", daysOld: 3 },
      { content: "User has a dog named Pixel.", source: "extracted", daysOld: 20 },
      { content: "User prefers concise answers.", source: "explicit", key: "response_style", daysOld: 30 },
      { content: "User is training for a 10k.", source: "extracted", daysOld: 15 }
    ],
    query: "What should I cook for pasta dinner tonight?",
    expected: {
      mustInclude: [0, 2],
      mustExclude: [3, 5],
      topK: 4
    }
  },
  {
    id: "recall-002",
    description: "Travel query should retrieve Japan travel memories",
    tags: ["semantic"],
    corpus: [
      { content: "User is visiting Tokyo in October.", source: "explicit", key: "trip_tokyo", daysOld: 5 },
      { content: "User prefers aisle seats on flights.", source: "extracted", daysOld: 40 },
      { content: "User wants hotel recommendations near Shinjuku.", source: "extracted", daysOld: 4 },
      { content: "User uses TypeScript for most projects.", source: "explicit", key: "lang", daysOld: 50 },
      { content: "User gets motion sick on boats.", source: "extracted", daysOld: 60 }
    ],
    query: "Help me plan my Tokyo trip",
    expected: {
      mustInclude: [0, 2],
      mustExclude: [3],
      topK: 4
    }
  },
  {
    id: "recall-003",
    description: "Programming query should pull JavaScript/TypeScript memories",
    tags: ["semantic"],
    corpus: [
      { content: "User prefers TypeScript over Python.", source: "explicit", key: "preferred_language", daysOld: 10 },
      { content: "User is deploying on Cloudflare Workers.", source: "extracted", daysOld: 8 },
      { content: "User's son likes astronomy.", source: "extracted", daysOld: 18 },
      { content: "User wants strict TypeScript examples.", source: "extracted", daysOld: 6 },
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 80 }
    ],
    query: "Show me a TypeScript example for a Cloudflare Worker",
    expected: {
      mustInclude: [0, 1, 3],
      mustExclude: [2, 4],
      topK: 4
    }
  },
  {
    id: "recall-004",
    description: "Fitness query should retrieve running-related memories",
    tags: ["semantic"],
    corpus: [
      { content: "User is training for their first marathon.", source: "explicit", key: "fitness_goal", daysOld: 14 },
      { content: "User prefers vegetarian recipes.", source: "extracted", daysOld: 11 },
      { content: "User injured their ankle last winter.", source: "extracted", daysOld: 120 },
      { content: "User usually runs on Tuesday and Saturday mornings.", source: "extracted", daysOld: 9 },
      { content: "User lives in Seattle.", source: "explicit", key: "city", daysOld: 90 }
    ],
    query: "Can you help me think about my running schedule this week?",
    expected: {
      mustInclude: [0, 3],
      mustExclude: [1],
      topK: 4
    }
  },
  {
    id: "recall-005",
    description: "Dietary planning query should surface allergy and food preferences",
    tags: ["semantic"],
    corpus: [
      { content: "User is allergic to peanuts.", source: "explicit", key: "allergy", daysOld: 2 },
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 20 },
      { content: "User prefers metric units in recipes.", source: "extracted", daysOld: 13 },
      { content: "User uses Linear at work.", source: "extracted", daysOld: 17 },
      { content: "User enjoys jazz while working.", source: "extracted", daysOld: 25 }
    ],
    query: "Give me a safe dinner idea",
    expected: {
      mustInclude: [0, 1],
      mustExclude: [3, 4],
      topK: 4
    }
  },
  {
    id: "recall-006",
    description: "Education query should retrieve study-related memories",
    tags: ["semantic"],
    corpus: [
      { content: "User is studying for the CPA exam.", source: "explicit", key: "exam", daysOld: 6 },
      { content: "User wants short explanations with examples.", source: "extracted", daysOld: 22 },
      { content: "User works the night shift.", source: "extracted", daysOld: 30 },
      { content: "User struggles with bond accounting questions.", source: "extracted", daysOld: 3 },
      { content: "User is planning a Tokyo trip.", source: "explicit", key: "travel", daysOld: 50 }
    ],
    query: "Help me review for accounting exam topics",
    expected: {
      mustInclude: [0, 3],
      mustExclude: [4],
      topK: 4
    }
  },
  {
    id: "recall-007",
    description: "Parenting query should retrieve child-related context",
    tags: ["semantic"],
    corpus: [
      { content: "User has a son named Liam who loves astronomy.", source: "explicit", key: "child", daysOld: 12 },
      { content: "User prefers concise answers.", source: "explicit", key: "response_style", daysOld: 70 },
      { content: "User is left-handed.", source: "extracted", daysOld: 100 },
      { content: "User wants weekend science activities for Liam.", source: "extracted", daysOld: 4 },
      { content: "User uses TypeScript for work.", source: "extracted", daysOld: 8 }
    ],
    query: "Any fun astronomy ideas for my kid this weekend?",
    expected: {
      mustInclude: [0, 3],
      mustExclude: [2, 4],
      topK: 4
    }
  },
  {
    id: "recall-008",
    description: "Writing-style query should retrieve response-style preferences",
    tags: ["semantic"],
    corpus: [
      { content: "User prefers concise answers.", source: "explicit", key: "response_style", daysOld: 40 },
      { content: "User likes bullet lists for planning.", source: "extracted", daysOld: 8 },
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 90 },
      { content: "User lives in Portland.", source: "extracted", daysOld: 200 }
    ],
    query: "Explain this to me briefly and in a structured way",
    expected: {
      mustInclude: [0, 1],
      mustExclude: [2, 3],
      topK: 4
    }
  },
  {
    id: "recall-009",
    description: "Pet-related query should retrieve dog context",
    tags: ["semantic"],
    corpus: [
      { content: "User has a dog named Pixel.", source: "explicit", key: "pet", daysOld: 16 },
      { content: "Pixel is afraid of fireworks.", source: "extracted", daysOld: 5 },
      { content: "User is studying for the CPA exam.", source: "extracted", daysOld: 11 },
      { content: "User prefers aisle seats on flights.", source: "extracted", daysOld: 45 }
    ],
    query: "How can I help my dog stay calm during loud noises?",
    expected: {
      mustInclude: [0, 1],
      mustExclude: [2, 3],
      topK: 4
    }
  },
  {
    id: "recall-010",
    description: "Work tooling query should retrieve Linear/project-management memories",
    tags: ["semantic"],
    corpus: [
      { content: "User's team uses Linear for project tracking.", source: "explicit", key: "pm_tool", daysOld: 25 },
      { content: "User wants help writing bug tickets clearly.", source: "extracted", daysOld: 3 },
      { content: "User prefers metric units for cooking.", source: "extracted", daysOld: 14 },
      { content: "User is training for a marathon.", source: "explicit", key: "fitness_goal", daysOld: 9 }
    ],
    query: "Help me write a good issue for my team's tracker",
    expected: {
      mustInclude: [0, 1],
      mustExclude: [2, 3],
      topK: 4
    }
  },

  // ---------------------------------------------------------------------------
  // RECENCY TIEBREAKERS (5)
  // ---------------------------------------------------------------------------

  {
    id: "recall-011",
    description: "More recent pasta preference should beat older similar pasta memory",
    tags: ["recency"],
    corpus: [
      { content: "User likes spicy pasta dishes.", source: "extracted", daysOld: 2 },
      { content: "User likes creamy pasta dishes.", source: "extracted", daysOld: 120 },
      { content: "User has a dog named Pixel.", source: "explicit", key: "pet", daysOld: 10 }
    ],
    query: "What kind of pasta might I want tonight?",
    expected: {
      mustInclude: [0],
      mustExclude: [2],
      topK: 2
    }
  },
  {
    id: "recall-012",
    description: "Recent travel preference should outrank older similar one",
    tags: ["recency"],
    corpus: [
      { content: "User prefers window seats on flights.", source: "extracted", daysOld: 200 },
      { content: "User now prefers aisle seats on flights.", source: "extracted", daysOld: 4 },
      { content: "User lives in Seattle.", source: "explicit", key: "city", daysOld: 50 }
    ],
    query: "What flight seat should I pick?",
    expected: {
      mustInclude: [1],
      mustExclude: [2],
      topK: 2
    }
  },
  {
    id: "recall-013",
    description: "Recent study pain point should rank above older related one",
    tags: ["recency"],
    corpus: [
      { content: "User struggles with partnership accounting questions.", source: "extracted", daysOld: 90 },
      { content: "User struggles with bond accounting questions.", source: "extracted", daysOld: 1 },
      { content: "User is studying for the CPA exam.", source: "explicit", key: "exam", daysOld: 8 }
    ],
    query: "What accounting topic should I review?",
    expected: {
      mustInclude: [1, 2],
      topK: 2
    }
  },
  {
    id: "recall-014",
    description: "Recent exercise pattern should outrank stale one",
    tags: ["recency"],
    corpus: [
      { content: "User runs in the evenings.", source: "extracted", daysOld: 180 },
      { content: "User now runs in the mornings before work.", source: "extracted", daysOld: 3 },
      { content: "User prefers concise answers.", source: "explicit", key: "response_style", daysOld: 20 }
    ],
    query: "When do I usually run?",
    expected: {
      mustInclude: [1],
      topK: 2
    }
  },
  {
    id: "recall-015",
    description: "Recent food constraint should beat older conflicting one",
    tags: ["recency"],
    corpus: [
      { content: "User is trying to eat more dairy.", source: "extracted", daysOld: 150 },
      { content: "User is avoiding dairy lately.", source: "extracted", daysOld: 2 },
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 25 }
    ],
    query: "Any dinner ideas that fit what I'm eating right now?",
    expected: {
      mustInclude: [1, 2],
      topK: 2
    }
  },
  // NOTE: recall-015 is also a future supersession test case once superseded_by
  // filtering lands. For Priority 4 it is intentionally a recency test.

  // ---------------------------------------------------------------------------
  // HIERARCHY TIEBREAKERS (5)
  // explicit > extracted when relevance is similar
  // ---------------------------------------------------------------------------

  {
    id: "recall-016",
    description: "Explicit language preference should beat similar extracted one",
    tags: ["hierarchy"],
    corpus: [
      { content: "User prefers TypeScript.", source: "explicit", key: "preferred_language", daysOld: 100 },
      { content: "User often asks for JavaScript examples.", source: "extracted", daysOld: 5 },
      { content: "User is building on Cloudflare Workers.", source: "extracted", daysOld: 8 }
    ],
    query: "Show me an example in the language I usually want",
    expected: {
      mustInclude: [0],
      topK: 2
    }
  },
  {
    id: "recall-017",
    description: "Explicit diet fact should beat similar extracted food preference",
    tags: ["hierarchy"],
    corpus: [
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 90 },
      { content: "User likes meatless meals.", source: "extracted", daysOld: 7 },
      { content: "User prefers metric recipe units.", source: "extracted", daysOld: 6 }
    ],
    query: "What kind of dinner should I suggest?",
    expected: {
      mustInclude: [0],
      topK: 2
    }
  },
  {
    id: "recall-018",
    description: "Explicit response-style preference should beat inferred style memory",
    tags: ["hierarchy"],
    corpus: [
      { content: "User prefers concise answers.", source: "explicit", key: "response_style", daysOld: 200 },
      { content: "User asked for a short explanation last week.", source: "extracted", daysOld: 7 },
      { content: "User is studying for the CPA exam.", source: "extracted", daysOld: 9 }
    ],
    query: "How should I format this response for them?",
    expected: {
      mustInclude: [0],
      topK: 2
    }
  },
  // NOTE: In recall-018, the text "last week" is intentionally pinned to
  // daysOld: 7. If one changes, the other should be updated too.

  {
    id: "recall-019",
    description: "Explicit pet fact should beat related extracted pet detail",
    tags: ["hierarchy"],
    corpus: [
      { content: "User has a dog named Pixel.", source: "explicit", key: "pet", daysOld: 120 },
      { content: "Pixel dislikes the vacuum cleaner.", source: "extracted", daysOld: 4 },
      { content: "User lives in Seattle.", source: "explicit", key: "city", daysOld: 20 }
    ],
    query: "Tell me about the user's dog",
    expected: {
      mustInclude: [0, 1],
      topK: 2
    }
  },
  {
    id: "recall-020",
    description: "Explicit city should beat looser extracted location detail",
    tags: ["hierarchy"],
    corpus: [
      { content: "User lives in Seattle.", source: "explicit", key: "city", daysOld: 80 },
      { content: "User mentioned Capitol Hill recently.", source: "extracted", daysOld: 3 },
      { content: "User likes jazz music.", source: "extracted", daysOld: 15 }
    ],
    query: "Where is this user based?",
    expected: {
      mustInclude: [0],
      topK: 2
    }
  },

  // ---------------------------------------------------------------------------
  // DISTRACTOR REJECTION (5)
  // ---------------------------------------------------------------------------

  {
    id: "recall-021",
    description: "Cooking query should ignore many unrelated work memories",
    tags: ["distractor"],
    corpus: [
      { content: "User prefers vegetarian meals.", source: "explicit", key: "diet", daysOld: 20 },
      { content: "User wants metric units in recipes.", source: "explicit", key: "recipe_units", daysOld: 25 },
      { content: "User is allergic to peanuts.", source: "explicit", key: "allergy", daysOld: 10 },
      { content: "User uses Linear.", source: "extracted", daysOld: 5 },
      { content: "User prefers TypeScript.", source: "explicit", key: "lang", daysOld: 18 },
      { content: "User is building on Cloudflare Workers.", source: "extracted", daysOld: 9 },
      { content: "User has a dog named Pixel.", source: "extracted", daysOld: 30 },
      { content: "User likes jazz while working.", source: "extracted", daysOld: 45 }
    ],
    query: "Suggest a recipe that fits my diet",
    expected: {
      mustInclude: [0, 1, 2],
      mustExclude: [3, 4, 5],
      topK: 4
    }
  },
  {
    id: "recall-022",
    description: "Programming query should ignore travel and family distractors",
    tags: ["distractor"],
    corpus: [
      { content: "User prefers TypeScript.", source: "explicit", key: "lang", daysOld: 12 },
      { content: "User deploys on Cloudflare Workers.", source: "explicit", key: "runtime", daysOld: 14 },
      { content: "User likes strict typing and small examples.", source: "extracted", daysOld: 6 },
      { content: "User is visiting Tokyo in October.", source: "extracted", daysOld: 3 },
      { content: "User has a son named Liam.", source: "explicit", key: "child", daysOld: 40 },
      { content: "User prefers aisle seats.", source: "extracted", daysOld: 80 }
    ],
    query: "Give me a small code example for my usual stack",
    expected: {
      mustInclude: [0, 1, 2],
      mustExclude: [3, 4, 5],
      topK: 4
    }
  },
  {
    id: "recall-023",
    description: "Family activity query should reject technical distractors",
    tags: ["distractor"],
    corpus: [
      { content: "User's son Liam loves astronomy.", source: "explicit", key: "child_interest", daysOld: 16 },
      { content: "User wants weekend science activities for Liam.", source: "extracted", daysOld: 4 },
      { content: "User lives in Seattle.", source: "explicit", key: "city", daysOld: 50 },
      { content: "User prefers TypeScript.", source: "explicit", key: "lang", daysOld: 8 },
      { content: "User uses Linear.", source: "extracted", daysOld: 10 },
      { content: "User is building on Workers.", source: "extracted", daysOld: 9 }
    ],
    query: "What should I do with my kid this weekend?",
    expected: {
      mustInclude: [0, 1],
      mustExclude: [3, 4, 5],
      topK: 4
    }
  },
  {
    id: "recall-024",
    description: "Travel planning query should reject food and coding distractors",
    tags: ["distractor"],
    corpus: [
      { content: "User is visiting Tokyo in October.", source: "explicit", key: "trip", daysOld: 5 },
      { content: "User wants to stay near Shinjuku.", source: "extracted", daysOld: 4 },
      { content: "User prefers aisle seats.", source: "extracted", daysOld: 30 },
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 60 },
      { content: "User prefers TypeScript.", source: "explicit", key: "lang", daysOld: 14 },
      { content: "User likes concise answers.", source: "explicit", key: "response_style", daysOld: 7 }
    ],
    query: "Help me think about where to stay on my Japan trip",
    expected: {
      mustInclude: [0, 1],
      mustExclude: [3, 4],
      topK: 4
    }
  },
  {
    id: "recall-025",
    description: "Study query should reject pet and travel distractors",
    tags: ["distractor"],
    corpus: [
      { content: "User is studying for the CPA exam.", source: "explicit", key: "exam", daysOld: 9 },
      { content: "User struggles with bond accounting.", source: "extracted", daysOld: 2 },
      { content: "User wants practice questions with explanations.", source: "extracted", daysOld: 7 },
      { content: "User has a dog named Pixel.", source: "explicit", key: "pet", daysOld: 20 },
      { content: "User is visiting Tokyo next month.", source: "extracted", daysOld: 3 }
    ],
    query: "Help me study accounting tonight",
    expected: {
      mustInclude: [0, 1, 2],
      mustExclude: [3, 4],
      topK: 4
    }
  },

  // ---------------------------------------------------------------------------
  // EMPTY / DEFAULTS / COLD START (3)
  // ---------------------------------------------------------------------------

  {
    id: "recall-026",
    description: "Cold start with no memories should return nothing relevant",
    tags: ["cold_start"],
    corpus: [],
    query: "What do you know about me?",
    expected: {
      mustInclude: [],
      topK: 4
    }
  },
  {
    id: "recall-027",
    description: "Single-memory user should still retrieve the only relevant memory",
    tags: ["cold_start"],
    corpus: [
      { content: "User prefers concise answers.", source: "explicit", key: "response_style", daysOld: 2 }
    ],
    query: "How should you answer me?",
    expected: {
      mustInclude: [0],
      topK: 1
    }
  },
  {
    id: "recall-028",
    description: "Sparse corpus should still retrieve the one topical memory",
    tags: ["cold_start"],
    corpus: [
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 10 },
      { content: "User uses TypeScript.", source: "explicit", key: "lang", daysOld: 10 }
    ],
    query: "What food constraints should you keep in mind?",
    expected: {
      mustInclude: [0],
      mustExclude: [1],
      topK: 2
    }
  },

  // ---------------------------------------------------------------------------
  // NULL-EMBEDDING EXPLICIT MEMORIES (2)
  // These are intended to exercise explicit-memory fallback behavior.
  // ---------------------------------------------------------------------------

  {
    id: "recall-029",
    description: "Explicit memory without embedding should still rank for direct preference query",
    tags: ["null_embedding"],
    corpus: [
      { content: "User prefers TypeScript over Python.", source: "explicit", key: "preferred_language", daysOld: 15 },
      { content: "User asked for a JavaScript snippet recently.", source: "extracted", daysOld: 2 },
      { content: "User likes concise answers.", source: "explicit", key: "response_style", daysOld: 20 }
    ],
    query: "Which programming language should I default to for this user?",
    expected: {
      mustInclude: [0],
      topK: 2
    }
  },
  {
    id: "recall-030",
    description: "Explicit food constraint without embedding should survive against semantically-rich extracted distractors",
    tags: ["null_embedding"],
    corpus: [
      { content: "User is allergic to peanuts.", source: "explicit", key: "allergy", daysOld: 40 },
      { content: "User asked for Thai curry ideas yesterday.", source: "extracted", daysOld: 1 },
      { content: "User likes noodle dishes.", source: "extracted", daysOld: 3 },
      { content: "User is vegetarian.", source: "explicit", key: "diet", daysOld: 20 }
    ],
    query: "What safety constraints matter for food suggestions?",
    expected: {
      mustInclude: [0, 3],
      topK: 3
    }
  }
];