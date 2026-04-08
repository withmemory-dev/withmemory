const BASE_URL = process.env.WITHMEMORY_BASE_URL ?? "http://localhost:8787";
const API_KEY = process.env.WITHMEMORY_API_KEY;

if (!API_KEY) {
  console.error("ERROR: WITHMEMORY_API_KEY is required. Pass it as an environment variable.");
  process.exit(1);
}

const userId = `e2e_test_${Date.now()}`;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function apiCall(
  path: string,
  body: unknown,
  options: { key?: string } = {}
): Promise<{ status: number; body: any }> {
  const key = options.key ?? API_KEY;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed };
}

type Test = { name: string; fn: () => Promise<void> };

const tests: Test[] = [];
let firstMemoryId: string;

tests.push({
  name: "Recall on nonexistent user returns empty",
  fn: async () => {
    const res = await apiCall("/v1/recall", { userId, input: "hello" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.promptBlock === "", `expected empty promptBlock, got "${res.body.promptBlock}"`);
    assert(res.body.memories.length === 0, `expected 0 memories, got ${res.body.memories.length}`);
  },
});

tests.push({
  name: "Set first memory: name",
  fn: async () => {
    const res = await apiCall("/v1/set", { userId, key: "name", value: "Andrew" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory.source === "explicit", `expected source "explicit"`);
    assert(res.body.memory.key === "name", `expected key "name"`);
    assert(res.body.memory.value === "Andrew", `expected value "Andrew"`);
    assert(res.body.memory.userId === userId, `expected userId "${userId}"`);
    firstMemoryId = res.body.memory.id;
  },
});

tests.push({
  name: "Set second memory: role",
  fn: async () => {
    const res = await apiCall("/v1/set", { userId, key: "role", value: "engineer" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory.key === "role", `expected key "role"`);
    assert(res.body.memory.value === "engineer", `expected value "engineer"`);
  },
});

tests.push({
  name: "Set third memory: subscription",
  fn: async () => {
    const res = await apiCall("/v1/set", { userId, key: "subscription", value: "pro" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory.key === "subscription", `expected key "subscription"`);
    assert(res.body.memory.value === "pro", `expected value "pro"`);
  },
});

tests.push({
  name: "Recall returns all three memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { userId, input: "tell me about myself" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 3, `expected 3 memories, got ${res.body.memories.length}`);
    assert(res.body.promptBlock.length > 0, "expected non-empty promptBlock");
    assert(res.body.promptBlock.includes("name: Andrew"), `promptBlock missing "name: Andrew"`);
    assert(
      res.body.promptBlock.includes("role: engineer"),
      `promptBlock missing "role: engineer"`
    );
    assert(
      res.body.promptBlock.includes("subscription: pro"),
      `promptBlock missing "subscription: pro"`
    );
    // Verify ordering: most recently updated first (subscription → role → name)
    const keys = res.body.memories.map((m: any) => m.key);
    assert(keys[0] === "subscription", `expected first key "subscription", got "${keys[0]}"`);
    assert(keys[1] === "role", `expected second key "role", got "${keys[1]}"`);
    assert(keys[2] === "name", `expected third key "name", got "${keys[2]}"`);
  },
});

tests.push({
  name: "Recall with maxItems=2 returns 2 memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { userId, input: "hi", maxItems: 2 });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 2, `expected 2 memories, got ${res.body.memories.length}`);
    const keys = res.body.memories.map((m: any) => m.key);
    assert(keys[0] === "subscription", `expected first key "subscription", got "${keys[0]}"`);
    assert(keys[1] === "role", `expected second key "role", got "${keys[1]}"`);
  },
});

tests.push({
  name: "Upsert updates existing memory",
  fn: async () => {
    const res = await apiCall("/v1/set", { userId, key: "name", value: "Andrew Gierke" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.memory.id === firstMemoryId,
      `expected same id ${firstMemoryId}, got ${res.body.memory.id}`
    );
    assert(res.body.memory.value === "Andrew Gierke", `expected value "Andrew Gierke"`);
    assert(
      res.body.memory.updatedAt > res.body.memory.createdAt,
      "expected updatedAt > createdAt after upsert"
    );
  },
});

tests.push({
  name: "Recall after upsert reflects the change",
  fn: async () => {
    const res = await apiCall("/v1/recall", { userId, input: "who am i" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const nameMem = res.body.memories.find((m: any) => m.key === "name");
    assert(nameMem !== undefined, "expected to find name memory in recall");
    assert(nameMem.value === "Andrew Gierke", `expected value "Andrew Gierke", got "${nameMem.value}"`);
  },
});

tests.push({
  name: "Auth failure returns 401",
  fn: async () => {
    const res = await apiCall(
      "/v1/set",
      { userId, key: "x", value: "y" },
      { key: "wm_test_definitely_not_valid" }
    );
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(
      res.body.error?.code === "unauthorized",
      `expected error.code "unauthorized", got "${res.body.error?.code}"`
    );
  },
});

tests.push({
  name: "Validation failure returns 400",
  fn: async () => {
    const res = await apiCall("/v1/set", { userId: "x" });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request", got "${res.body.error?.code}"`
    );
  },
});

// ── /v1/get tests ─────────────────────────────────────────────────────────────

tests.push({
  name: "Get existing memory by key",
  fn: async () => {
    const res = await apiCall("/v1/get", { userId, key: "name" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory !== null, "expected memory to be non-null");
    assert(res.body.memory.key === "name", `expected key "name", got "${res.body.memory.key}"`);
    assert(
      res.body.memory.value === "Andrew Gierke",
      `expected value "Andrew Gierke", got "${res.body.memory.value}"`
    );
  },
});

tests.push({
  name: "Get nonexistent key returns null memory",
  fn: async () => {
    const res = await apiCall("/v1/get", { userId, key: "nonexistent_key" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory === null, `expected null memory, got ${JSON.stringify(res.body.memory)}`);
  },
});

tests.push({
  name: "Get for nonexistent user returns null memory",
  fn: async () => {
    const res = await apiCall("/v1/get", { userId: "no_such_user_ever", key: "name" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory === null, `expected null memory`);
  },
});

// ── /v1/remove tests ──────────────────────────────────────────────────────────

tests.push({
  name: "Remove existing memory returns deleted: true",
  fn: async () => {
    // Set a throwaway memory to remove
    await apiCall("/v1/set", { userId, key: "to_delete", value: "temporary" });
    const res = await apiCall("/v1/remove", { userId, key: "to_delete" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.deleted === true, `expected deleted: true, got ${res.body.deleted}`);
    // Verify it's gone
    const check = await apiCall("/v1/get", { userId, key: "to_delete" });
    assert(check.body.memory === null, "expected memory to be gone after remove");
  },
});

tests.push({
  name: "Remove nonexistent key returns deleted: false",
  fn: async () => {
    const res = await apiCall("/v1/remove", { userId, key: "never_existed" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.deleted === false, `expected deleted: false, got ${res.body.deleted}`);
  },
});

// ── /v1/health test ───────────────────────────────────────────────────────────

tests.push({
  name: "Authenticated /v1/health returns ok",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json() as any;
    assert(body.status === "ok", `expected status "ok", got "${body.status}"`);
    assert(typeof body.version === "string", `expected version string, got ${typeof body.version}`);
  },
});

// ── 404 handler test ──────────────────────────────────────────────────────────

tests.push({
  name: "Unknown /v1 route returns 404 with error envelope",
  fn: async () => {
    const res = await apiCall("/v1/nonexistent", { userId });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(
      res.body.error?.code === "not_found",
      `expected error.code "not_found", got "${res.body.error?.code}"`
    );
  },
});

async function main() {
  const totalStart = performance.now();
  let passed = 0;
  let failed = 0;

  console.log(`\n▶ Running WithMemory E2E tests`);
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  User ID:  ${userId}\n`);

  for (const test of tests) {
    const start = performance.now();
    try {
      await test.fn();
      const ms = Math.round(performance.now() - start);
      console.log(`✓ ${test.name} (${ms}ms)`);
      passed++;
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      console.log(`✗ ${test.name} (${ms}ms)`);
      console.log(`  ${err instanceof Error ? err.message : err}\n`);
      failed++;
      break;
    }
  }

  const totalMs = ((performance.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (failed === 0) {
    console.log(`  ${passed} tests passed (${totalMs}s)`);
  } else {
    console.log(`  ${failed} of ${passed + failed} tests failed`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
