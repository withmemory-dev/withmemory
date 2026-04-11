import { createClient } from "../../packages/sdk/dist/index.js";

const BASE_URL = process.env.WITHMEMORY_BASE_URL ?? "http://localhost:8787";
const API_KEY = process.env.WITHMEMORY_API_KEY;
const API_KEY_B = process.env.WITHMEMORY_API_KEY_B;

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
    // Verify all three keys are present (order depends on semantic ranking)
    const keys = new Set(res.body.memories.map((m: any) => m.key));
    assert(keys.has("subscription"), `missing key "subscription"`);
    assert(keys.has("role"), `missing key "role"`);
    assert(keys.has("name"), `missing key "name"`);
  },
});

tests.push({
  name: "Recall with maxItems=2 returns 2 memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { userId, input: "hi", maxItems: 2 });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 2, `expected 2 memories, got ${res.body.memories.length}`);
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

// ── /v1/commit tests ─────────────────────────────────────────────────────────

tests.push({
  name: "Commit returns 202 Accepted",
  fn: async () => {
    const res = await apiCall("/v1/commit", {
      userId,
      input: "My name is Andrew and I work at Acme Corp.",
      output: "Nice to meet you, Andrew!",
    });
    assert(res.status === 202, `expected 202, got ${res.status}`);
  },
});

tests.push({
  name: "Commit with Idempotency-Key is idempotent",
  fn: async () => {
    const idemKey = `e2e_idem_${Date.now()}`;
    const body = {
      userId,
      input: "I prefer dark mode.",
      output: "Noted!",
    };
    const res1 = await fetch(`${BASE_URL}/v1/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "Idempotency-Key": idemKey,
      },
      body: JSON.stringify(body),
    });
    assert(res1.status === 202, `first call: expected 202, got ${res1.status}`);

    const res2 = await fetch(`${BASE_URL}/v1/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "Idempotency-Key": idemKey,
      },
      body: JSON.stringify(body),
    });
    assert(res2.status === 202, `second call: expected 202, got ${res2.status}`);
  },
});

tests.push({
  name: "Commit rejects oversized payload",
  fn: async () => {
    const res = await apiCall("/v1/commit", {
      userId,
      input: "x".repeat(20000),
      output: "y",
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request", got "${res.body.error?.code}"`
    );
    assert(
      res.body.error?.message === "Commit exceeds maximum size",
      `expected size error message`
    );
  },
});

tests.push({
  name: "Commit validation failure returns 400",
  fn: async () => {
    const res = await apiCall("/v1/commit", { userId });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request"`
    );
  },
});

// ── /v1/memories tests ───────────────────────────────────────────────────────

tests.push({
  name: "List memories for user with memories",
  fn: async () => {
    const res = await apiCall("/v1/memories", { userId });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body), "expected bare array response");
    // User should have at least the 3 memories from set tests (name, role, subscription)
    assert(res.body.length >= 3, `expected >= 3 memories, got ${res.body.length}`);
    // Verify Memory shape
    const first = res.body[0];
    assert(typeof first.id === "string", "expected id string");
    assert(typeof first.value === "string", "expected value string");
    assert(typeof first.source === "string", "expected source string");
  },
});

tests.push({
  name: "List memories for nonexistent user returns empty",
  fn: async () => {
    const res = await apiCall("/v1/memories", { userId: "no_such_user_ever_memories" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body), "expected bare array response");
    assert(res.body.length === 0, `expected 0 memories`);
  },
});

// ── DELETE /v1/memories/:id tests ────────────────────────────────────────────

tests.push({
  name: "Delete memory by ID returns deleted: true",
  fn: async () => {
    // Set a throwaway memory, then delete by ID
    const setRes = await apiCall("/v1/set", { userId, key: "to_delete_by_id", value: "temp" });
    assert(setRes.status === 200, `set: expected 200, got ${setRes.status}`);
    const memId = setRes.body.memory.id;

    const delRes = await fetch(`${BASE_URL}/v1/memories/${memId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(delRes.status === 200, `delete: expected 200, got ${delRes.status}`);
    const delBody = await delRes.json() as any;
    assert(delBody.deleted === true, `expected deleted: true`);

    // Verify it's gone via get
    const getRes = await apiCall("/v1/get", { userId, key: "to_delete_by_id" });
    assert(getRes.body.memory === null, "expected memory to be gone after delete");
  },
});

tests.push({
  name: "Delete nonexistent memory returns deleted: false",
  fn: async () => {
    const delRes = await fetch(`${BASE_URL}/v1/memories/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(delRes.status === 200, `expected 200, got ${delRes.status}`);
    const delBody = await delRes.json() as any;
    assert(delBody.deleted === false, `expected deleted: false`);
  },
});

tests.push({
  name: "Delete with invalid UUID returns 400",
  fn: async () => {
    const delRes = await fetch(`${BASE_URL}/v1/memories/not-a-uuid`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(delRes.status === 400, `expected 400, got ${delRes.status}`);
    const delBody = await delRes.json() as any;
    assert(delBody.error?.code === "invalid_request", `expected invalid_request`);
  },
});

// ── /v1/recall defaults tests ────────────────────────────────────────────────

tests.push({
  name: "Recall with defaults for nonexistent user returns defaults in promptBlock",
  fn: async () => {
    const res = await apiCall("/v1/recall", {
      userId: "recall_defaults_test_user",
      input: "hello",
      defaults: { plan: "pro", tier: "beta" },
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.promptBlock.includes("plan: pro"), `expected "plan: pro" in promptBlock`);
    assert(res.body.promptBlock.includes("tier: beta"), `expected "tier: beta" in promptBlock`);
    assert(res.body.memories.length === 0, `expected 0 memories (defaults are not real memories)`);
  },
});

// ── SDK register() + recall() defaults test ─────────────────────────────────

tests.push({
  name: "SDK register() defaults appear in recall() promptBlock",
  fn: async () => {
    const client = createClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    client.register({ theme: "dark", language: "en" });
    const result = await client.recall({
      userId: "sdk_register_test_nonexistent_user",
      input: "hello",
    });
    assert(result.promptBlock.includes("theme: dark"), `expected "theme: dark" in promptBlock`);
    assert(
      result.promptBlock.includes("language: en"),
      `expected "language: en" in promptBlock`
    );
    assert(result.memories.length === 0, `expected 0 memories for nonexistent user`);
  },
});

// ── /v1/account/extraction-prompt tests ─────��────────────────────────────────

tests.push({
  name: "Get extraction prompt returns default when unset",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(body.source === "default", `expected source "default", got "${body.source}"`);
    assert(body.prompt === null, `expected null prompt, got "${body.prompt}"`);
  },
});

tests.push({
  name: "Set custom extraction prompt",
  fn: async () => {
    const res = await apiCall("/v1/account/extraction-prompt", {
      prompt: "You are a custom extraction prompt for testing.",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.source === "custom", `expected source "custom"`);
    assert(
      res.body.prompt === "You are a custom extraction prompt for testing.",
      `expected prompt to match`
    );
  },
});

tests.push({
  name: "Get extraction prompt returns custom after set",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(body.source === "custom", `expected source "custom"`);
    assert(
      body.prompt === "You are a custom extraction prompt for testing.",
      `expected custom prompt text`
    );
  },
});

tests.push({
  name: "Reset extraction prompt returns reset: true",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(body.reset === true, `expected reset: true, got ${body.reset}`);
  },
});

tests.push({
  name: "Get extraction prompt returns default after reset",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(body.source === "default", `expected source "default" after reset`);
    assert(body.prompt === null, `expected null prompt after reset`);
  },
});

tests.push({
  name: "Set extraction prompt validation rejects empty string",
  fn: async () => {
    const res = await apiCall("/v1/account/extraction-prompt", { prompt: "   " });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request"`
    );
  },
});

// ─�� Cross-account ownership test (requires WITHMEMORY_API_KEY_B) ────────���────

if (API_KEY_B) {
  tests.push({
    name: "Cross-account delete returns deleted: false (ownership boundary)",
    fn: async () => {
      // 1. Create a memory under Account A
      const setRes = await apiCall("/v1/set", { userId, key: "cross_acct_test", value: "secret" });
      assert(setRes.status === 200, `set: expected 200, got ${setRes.status}`);
      const memId = setRes.body.memory.id;

      // 2. Attempt to delete it using Account B's key
      const delRes = await fetch(`${BASE_URL}/v1/memories/${memId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${API_KEY_B}` },
      });
      assert(delRes.status === 200, `cross-account delete: expected 200, got ${delRes.status}`);
      const delBody = await delRes.json() as any;
      assert(
        delBody.deleted === false,
        `expected deleted: false (Account B cannot delete Account A's memory), got ${delBody.deleted}`
      );

      // 3. Verify the memory still exists via Account A
      const getRes = await apiCall("/v1/get", { userId, key: "cross_acct_test" });
      assert(
        getRes.body.memory !== null,
        "expected memory to still exist after cross-account delete attempt"
      );
      assert(
        getRes.body.memory.value === "secret",
        `expected value "secret", got "${getRes.body.memory.value}"`
      );

      // 4. Clean up: delete with Account A's key
      const cleanupRes = await fetch(`${BASE_URL}/v1/memories/${memId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      assert(cleanupRes.status === 200, `cleanup delete: expected 200`);
      const cleanupBody = await cleanupRes.json() as any;
      assert(cleanupBody.deleted === true, `cleanup: expected deleted: true`);
    },
  });
} else {
  console.log("⚠ Skipping cross-account ownership test (WITHMEMORY_API_KEY_B not set)");
}

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
