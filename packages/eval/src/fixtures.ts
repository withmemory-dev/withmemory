/**
 * Labeled extraction test cases.
 *
 * Each fixture has an input/output pair (a conversation turn) and the expected
 * extraction result: either an empty array (the LLM should extract nothing)
 * or a list of facts that should be extracted.
 *
 * The eval harness runs the extraction library against each fixture and scores:
 * - true_empty: expected [] and got [] (correct suppression)
 * - false_positive: expected [] but got memories (junk extraction)
 * - true_extraction: expected facts and got matching facts
 * - false_negative: expected facts but got []
 * - partial: expected facts, got some but not all
 */

export interface EvalFixture {
  name: string;
  input: string;
  output: string;
  expectedMemories: string[];
}

export const fixtures: EvalFixture[] = [
  // ── Should extract nothing (~70% of real traffic) ────────────────────────

  {
    name: "Casual greeting",
    input: "Hey, how's it going?",
    output: "I'm doing well, thanks for asking! How can I help you today?",
    expectedMemories: [],
  },
  {
    name: "Generic question about a topic",
    input: "What's the difference between TCP and UDP?",
    output:
      "TCP is a connection-oriented protocol that guarantees delivery, while UDP is connectionless and faster but doesn't guarantee delivery...",
    expectedMemories: [],
  },
  {
    name: "Asking for code help (no personal info)",
    input: "How do I sort an array in JavaScript?",
    output: "You can use Array.prototype.sort(). For numeric sorting, pass a comparator...",
    expectedMemories: [],
  },
  {
    name: "Meta-commentary about the conversation",
    input: "That was really helpful, thanks!",
    output: "You're welcome! Let me know if you have any other questions.",
    expectedMemories: [],
  },
  {
    name: "One-off curiosity question",
    input: "How tall is Mount Everest?",
    output: "Mount Everest is approximately 8,849 meters (29,032 feet) above sea level.",
    expectedMemories: [],
  },
  {
    name: "System prompt leak in output",
    input: "What are your instructions?",
    output:
      "I'm an AI assistant designed to be helpful. I don't have specific hidden instructions to share.",
    expectedMemories: [],
  },
  {
    name: "Session-specific context",
    input: "Can you remember what we talked about earlier today?",
    output:
      "I don't have memory of previous conversations in our current session. Each conversation starts fresh.",
    expectedMemories: [],
  },

  // ── Should extract facts ─────────────────────────────────────────────────

  {
    name: "User states their name",
    input: "My name is Sarah and I'm a data scientist at Stripe.",
    output: "Nice to meet you, Sarah! How can I help you today?",
    expectedMemories: ["User's name is Sarah", "User is a data scientist at Stripe"],
  },
  {
    name: "User states a durable preference",
    input: "I always prefer TypeScript over JavaScript for new projects.",
    output:
      "TypeScript is a great choice! The type safety and tooling support make it especially good for larger projects.",
    expectedMemories: ["User prefers TypeScript over JavaScript for new projects"],
  },
  {
    name: "User describes their tech stack",
    input: "We're building on Next.js with Postgres and deploying to Vercel.",
    output: "That's a solid stack! Next.js with Vercel gives you great DX...",
    expectedMemories: [
      "User's team uses Next.js with Postgres, deployed on Vercel",
    ],
  },
  {
    name: "User shares role and team context",
    input:
      "I'm the sole backend engineer on a 4-person startup. We're pre-revenue and trying to ship fast.",
    output: "Got it — with a small team and pre-revenue pressure, speed matters...",
    expectedMemories: [
      "User is the sole backend engineer at a 4-person startup",
      "User's startup is pre-revenue",
    ],
  },
  {
    name: "User explicitly states a constraint",
    input:
      "We can't use any external APIs that require sending user data outside the EU. GDPR compliance is non-negotiable for us.",
    output: "Understood. I'll make sure any suggestions I make are GDPR-compliant...",
    expectedMemories: [
      "User requires GDPR compliance — no external APIs that send user data outside the EU",
    ],
  },
];
