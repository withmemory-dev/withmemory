import { createClient } from "../../packages/sdk/dist/index.js";
import pgPkg from "postgres";

const BASE_URL = process.env.WITHMEMORY_BASE_URL ?? "http://localhost:8787";
const API_KEY = process.env.WITHMEMORY_API_KEY;
const API_KEY_B = process.env.WITHMEMORY_API_KEY_B;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("ERROR: WITHMEMORY_API_KEY is required. Pass it as an environment variable.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required for plan enforcement tests.");
  process.exit(1);
}

// ── DB helper for plan enforcement tests ────────────────────────────────────
// Direct DB connection for mutating test account state (plan tier, memory limit).
// Uses the same postgres-js driver as the server.
const testDb = pgPkg(DATABASE_URL, { max: 1, idle_timeout: 5 });

let testAccountId: string;

async function resolveTestAccountId(): Promise<string> {
  // key_prefix length varies across key generations (8 chars for legacy keys,
  // 11 chars for wm_test_ keys). Query all rows whose stored prefix matches
  // the start of the API key, then pick the best match.
  const rows = await testDb`
    SELECT a.id, k.key_prefix
    FROM wm_api_keys k
    JOIN wm_accounts a ON k.account_id = a.id
    WHERE ${API_KEY!} LIKE key_prefix || '%'
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`No account found for API key`);
  return rows[0].id;
}

async function updateTestAccount(patch: {
  plan_tier?: string;
  memory_limit?: number;
  extraction_prompt?: string | null;
}): Promise<void> {
  if (patch.plan_tier !== undefined) {
    await testDb`UPDATE wm_accounts SET plan_tier = ${patch.plan_tier} WHERE id = ${testAccountId}`;
  }
  if (patch.memory_limit !== undefined) {
    await testDb`UPDATE wm_accounts SET memory_limit = ${patch.memory_limit} WHERE id = ${testAccountId}`;
  }
  if (patch.extraction_prompt !== undefined) {
    await testDb`UPDATE wm_accounts SET extraction_prompt = ${patch.extraction_prompt} WHERE id = ${testAccountId}`;
  }
}

const scope = `e2e_test_${Date.now()}`;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function apiCall(
  path: string,
  body: unknown,
  options: { key?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
  const key = options.key ?? API_KEY;
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      ...(options.headers ?? {}),
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
    const res = await apiCall("/v1/recall", { scope, query: "hello" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.context === "", `expected empty context, got "${res.body.context}"`);
    assert(res.body.memories.length === 0, `expected 0 memories, got ${res.body.memories.length}`);
  },
});

tests.push({
  name: "Add first memory: name (explicit)",
  fn: async () => {
    const res = await apiCall("/v1/memories", { scope, key: "name", value: "Andrew" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 1, `expected 1 memory, got ${res.body.memories.length}`);
    assert(
      typeof res.body.request_id === "string" && res.body.request_id.length > 0,
      `expected request_id in response body, got "${res.body.request_id}"`
    );
    const mem = res.body.memories[0];
    assert(mem.source === "explicit", `expected source "explicit"`);
    assert(mem.key === "name", `expected key "name"`);
    assert(mem.value === "Andrew", `expected value "Andrew"`);
    assert(mem.scope === scope, `expected scope "${scope}"`);
    firstMemoryId = mem.id;
  },
});

tests.push({
  name: "Add second memory: role (explicit)",
  fn: async () => {
    const res = await apiCall("/v1/memories", { scope, key: "role", value: "engineer" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 1, `expected 1 memory`);
    assert(res.body.memories[0].key === "role", `expected key "role"`);
    assert(res.body.memories[0].value === "engineer", `expected value "engineer"`);
  },
});

tests.push({
  name: "Add third memory: subscription (explicit)",
  fn: async () => {
    const res = await apiCall("/v1/memories", {
      scope,
      key: "subscription",
      value: "pro",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 1, `expected 1 memory`);
    assert(res.body.memories[0].key === "subscription", `expected key "subscription"`);
    assert(res.body.memories[0].value === "pro", `expected value "pro"`);
  },
});

tests.push({
  name: "Recall returns all three memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { scope, query: "tell me about myself" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 3, `expected 3 memories, got ${res.body.memories.length}`);
    assert(res.body.context.length > 0, "expected non-empty context");
    assert(
      typeof res.body.request_id === "string" && res.body.request_id.length > 0,
      `expected request_id in recall response`
    );
    assert(res.body.context.includes("name: Andrew"), `context missing "name: Andrew"`);
    assert(res.body.context.includes("role: engineer"), `context missing "role: engineer"`);
    assert(res.body.context.includes("subscription: pro"), `context missing "subscription: pro"`);
    const keys = new Set(res.body.memories.map((m: any) => m.key));
    assert(keys.has("subscription"), `missing key "subscription"`);
    assert(keys.has("role"), `missing key "role"`);
    assert(keys.has("name"), `missing key "name"`);
  },
});

tests.push({
  name: "Recall with maxItems=2 returns 2 memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { scope, query: "hi", maxItems: 2 });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 2, `expected 2 memories, got ${res.body.memories.length}`);
  },
});

tests.push({
  name: "Upsert updates existing memory",
  fn: async () => {
    const res = await apiCall("/v1/memories", {
      scope,
      key: "name",
      value: "Andrew Gierke",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 1, `expected 1 memory`);
    const mem = res.body.memories[0];
    assert(mem.id === firstMemoryId, `expected same id ${firstMemoryId}, got ${mem.id}`);
    assert(mem.value === "Andrew Gierke", `expected value "Andrew Gierke"`);
    assert(mem.updatedAt > mem.createdAt, "expected updatedAt > createdAt after upsert");
  },
});

tests.push({
  name: "Recall after upsert reflects the change",
  fn: async () => {
    const res = await apiCall("/v1/recall", { scope, query: "who am i" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const nameMem = res.body.memories.find((m: any) => m.key === "name");
    assert(nameMem !== undefined, "expected to find name memory in recall");
    assert(
      nameMem.value === "Andrew Gierke",
      `expected value "Andrew Gierke", got "${nameMem.value}"`
    );
  },
});

tests.push({
  name: "Auth failure returns 401",
  fn: async () => {
    const res = await apiCall(
      "/v1/memories",
      { scope, key: "x", value: "y" },
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
    const res = await apiCall("/v1/memories", { scope: "x" });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request", got "${res.body.error?.code}"`
    );
  },
});

// ── /v1/memories/get tests ──────────────────────────────────────────────────

tests.push({
  name: "Get existing memory by key",
  fn: async () => {
    const res = await apiCall("/v1/memories/get", { scope, key: "name" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory !== null, "expected memory to be non-null");
    assert(
      res.body.memory.key === "name",
      `expected key "name", got "${res.body.memory.key}"`
    );
    assert(
      res.body.memory.value === "Andrew Gierke",
      `expected value "Andrew Gierke", got "${res.body.memory.value}"`
    );
  },
});

tests.push({
  name: "Get nonexistent key returns null memory",
  fn: async () => {
    const res = await apiCall("/v1/memories/get", { scope, key: "nonexistent_key" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.memory === null,
      `expected null memory, got ${JSON.stringify(res.body.memory)}`
    );
  },
});

tests.push({
  name: "Get for nonexistent user returns null memory",
  fn: async () => {
    const res = await apiCall("/v1/memories/get", {
      scope: "no_such_user_ever",
      key: "name",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory === null, `expected null memory`);
  },
});

// ── /v1/memories/remove tests ───────────────────────────────────────────────

tests.push({
  name: "Remove existing memory returns result.deleted: true",
  fn: async () => {
    await apiCall("/v1/memories", { scope, key: "to_delete", value: "temporary" });
    const res = await apiCall("/v1/memories/remove", { scope, key: "to_delete" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.result?.deleted === true,
      `expected result.deleted: true, got ${JSON.stringify(res.body.result)}`
    );
    const check = await apiCall("/v1/memories/get", { scope, key: "to_delete" });
    assert(check.body.memory === null, "expected memory to be gone after remove");
  },
});

tests.push({
  name: "Remove nonexistent key returns result.deleted: false",
  fn: async () => {
    const res = await apiCall("/v1/memories/remove", { scope, key: "never_existed" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.result?.deleted === false,
      `expected result.deleted: false, got ${JSON.stringify(res.body.result)}`
    );
  },
});

// ── /v1/health test ─────────────────────────────────────────────────────────

tests.push({
  name: "Authenticated /v1/health returns ok",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(
      body.health?.status === "ok",
      `expected health.status "ok", got "${body.health?.status}"`
    );
    assert(
      typeof body.health?.version === "string",
      `expected health.version string, got ${typeof body.health?.version}`
    );
  },
});

// ── 404 handler test ────────────────────────────────────────────────────────

tests.push({
  name: "Unknown /v1 route returns 404 with error envelope",
  fn: async () => {
    const res = await apiCall("/v1/nonexistent", { scope });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(
      res.body.error?.code === "not_found",
      `expected error.code "not_found", got "${res.body.error?.code}"`
    );
  },
});

// ── Old routes return 404 ───────────────────────────────────────────────────

tests.push({
  name: "Old POST /v1/set returns 404",
  fn: async () => {
    const res = await apiCall("/v1/set", { scope, key: "test", value: "should 404" });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.error?.code === "not_found", `expected not_found`);
  },
});

tests.push({
  name: "Old POST /v1/get returns 404",
  fn: async () => {
    const res = await apiCall("/v1/get", { scope, key: "test" });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.error?.code === "not_found", `expected not_found`);
  },
});

tests.push({
  name: "Old POST /v1/remove returns 404",
  fn: async () => {
    const res = await apiCall("/v1/remove", { scope, key: "test" });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.error?.code === "not_found", `expected not_found`);
  },
});

tests.push({
  name: "Old POST /v1/commit returns 404",
  fn: async () => {
    const res = await apiCall("/v1/commit", { scope, input: "hello", output: "hi" });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.error?.code === "not_found", `expected not_found`);
  },
});

// ── Extraction path tests ───────────────────────────────────────────────────

tests.push({
  name: "Add with no key triggers extraction and returns facts",
  fn: async () => {
    const extractionScope = `e2e_extraction_${Date.now()}`;
    const res = await apiCall("/v1/memories", {
      scope: extractionScope,
      value:
        "The user's name is Alice and they live in Paris. They are a senior data scientist at Acme Corp.",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array");
    assert(
      res.body.memories.length >= 1,
      `expected >= 1 extracted memory, got ${res.body.memories.length}`
    );
    for (const m of res.body.memories) {
      assert(m.source === "extracted", `expected source "extracted", got "${m.source}"`);
      assert(m.key === null, `expected key null for extracted memory, got "${m.key}"`);
    }
  },
});

tests.push({
  name: "Add with no key returns empty array when extraction finds nothing",
  fn: async () => {
    const extractionScope = `e2e_extraction_empty_${Date.now()}`;
    const res = await apiCall("/v1/memories", {
      scope: extractionScope,
      value: "Hello there",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array");
    assert(
      res.body.memories.length === 0,
      `expected 0 memories for small talk, got ${res.body.memories.length}`
    );
  },
});

tests.push({
  name: "Add with key bypasses extraction",
  fn: async () => {
    const explicitScope = `e2e_explicit_${Date.now()}`;
    const res = await apiCall("/v1/memories", {
      scope: explicitScope,
      key: "name",
      value: "Alice",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 1, `expected 1 memory, got ${res.body.memories.length}`);
    assert(res.body.memories[0].source === "explicit", `expected source "explicit"`);
    assert(res.body.memories[0].key === "name", `expected key "name"`);
  },
});

tests.push({
  name: "Extracted memories appear in recall",
  fn: async () => {
    const extractionScope = `e2e_extraction_recall_${Date.now()}`;
    // Add via extraction path
    const addRes = await apiCall("/v1/memories", {
      scope: extractionScope,
      value: "The user is strictly vegetarian and allergic to peanuts",
    });
    assert(addRes.status === 200, `add: expected 200, got ${addRes.status}`);
    assert(addRes.body.memories.length >= 1, `expected >= 1 extracted memory`);

    // Recall should find them
    const recallRes = await apiCall("/v1/recall", {
      scope: extractionScope,
      query: "dietary restrictions",
    });
    assert(recallRes.status === 200, `recall: expected 200, got ${recallRes.status}`);
    assert(
      recallRes.body.memories.length >= 1,
      `expected >= 1 memory in recall, got ${recallRes.body.memories.length}`
    );
    assert(recallRes.body.context.length > 0, "expected non-empty context");
  },
});

tests.push({
  name: "Extraction path rejects oversized value",
  fn: async () => {
    const res = await apiCall("/v1/memories", {
      scope,
      value: "x".repeat(20000),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request", got "${res.body.error?.code}"`
    );
  },
});

tests.push({
  name: "Extraction path with Idempotency-Key is idempotent",
  fn: async () => {
    const idemScope = `e2e_idem_${Date.now()}`;
    const idemKey = `e2e_idem_key_${Date.now()}`;
    const body = {
      scope: idemScope,
      value: "The user's name is Bob and they work at Google",
    };
    const res1 = await apiCall("/v1/memories", body, {
      headers: { "Idempotency-Key": idemKey },
    });
    assert(res1.status === 200, `first call: expected 200, got ${res1.status}`);

    const res2 = await apiCall("/v1/memories", body, {
      headers: { "Idempotency-Key": idemKey },
    });
    assert(res2.status === 200, `second call: expected 200, got ${res2.status}`);
    // Should return the same memories (cached from exchange)
    assert(
      res2.body.memories.length === res1.body.memories.length,
      `expected same memory count on replay, got ${res2.body.memories.length} vs ${res1.body.memories.length}`
    );
  },
});

// ── /v1/memories/list tests ─────────────────────────────────────────────────

tests.push({
  name: "List memories for user with memories",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { scope });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array in envelope");
    assert(
      res.body.nextCursor === null || typeof res.body.nextCursor === "string",
      "expected nextCursor"
    );
    assert(
      res.body.memories.length >= 3,
      `expected >= 3 memories, got ${res.body.memories.length}`
    );
    const first = res.body.memories[0];
    assert(typeof first.id === "string", "expected id string");
    assert(typeof first.value === "string", "expected value string");
    assert(typeof first.source === "string", "expected source string");
    assert(typeof first.scope === "string", "expected scope string");
  },
});

tests.push({
  name: "List memories for nonexistent user returns empty",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", {
      scope: "no_such_user_ever_memories",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array");
    assert(res.body.memories.length === 0, `expected 0 memories`);
    assert(res.body.nextCursor === null, "expected null nextCursor");
  },
});

tests.push({
  name: "Account-wide listing returns memories across users",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", {});
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array");
    assert(
      res.body.memories.length >= 3,
      `expected >= 3 memories, got ${res.body.memories.length}`
    );
  },
});

tests.push({
  name: "Source filter returns only explicit memories",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { scope, source: "explicit" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    for (const m of res.body.memories) {
      assert(m.source === "explicit", `expected source "explicit", got "${m.source}"`);
    }
  },
});

tests.push({
  name: "Search filter matches value content",
  fn: async () => {
    const searchKey = `search_test_${Date.now()}`;
    await apiCall("/v1/memories", {
      scope,
      key: searchKey,
      value: "xylophone_uniquetoken_987",
    });
    const res = await apiCall("/v1/memories/list", { scope, search: "xylophone_uniquetoken" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.memories.length >= 1,
      `expected >= 1 search result, got ${res.body.memories.length}`
    );
    const found = res.body.memories.some((m: any) => m.value === "xylophone_uniquetoken_987");
    assert(found, "expected to find memory with the unique search value");
    await apiCall("/v1/memories/remove", { scope, key: searchKey });
  },
});

tests.push({
  name: "includeTotal returns total count",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { scope, includeTotal: true });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      typeof res.body.total === "number",
      `expected total to be a number, got ${typeof res.body.total}`
    );
    assert(res.body.total >= 3, `expected total >= 3, got ${res.body.total}`);
  },
});

tests.push({
  name: "includeTotal omitted when not requested",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { scope });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(!("total" in res.body), `expected total to be absent, but it was present`);
  },
});

const paginationUserId = `e2e_pagination_${Date.now()}`;

tests.push({
  name: "Cursor pagination: create test data and paginate",
  fn: async () => {
    for (let i = 1; i <= 8; i++) {
      const res = await apiCall("/v1/memories", {
        scope: paginationUserId,
        key: `page_key_${String(i).padStart(2, "0")}`,
        value: `page_value_${i}`,
      });
      assert(res.status === 200, `set ${i}/8: expected 200, got ${res.status}`);
    }

    const page1 = await apiCall("/v1/memories/list", {
      scope: paginationUserId,
      limit: 5,
    });
    assert(page1.status === 200, `page1: expected 200, got ${page1.status}`);
    assert(
      page1.body.memories.length === 5,
      `page1: expected 5, got ${page1.body.memories.length}`
    );
    assert(page1.body.nextCursor !== null, "page1: expected non-null nextCursor");

    const page2 = await apiCall("/v1/memories/list", {
      scope: paginationUserId,
      limit: 5,
      cursor: page1.body.nextCursor,
    });
    assert(page2.status === 200, `page2: expected 200, got ${page2.status}`);
    assert(
      page2.body.memories.length === 3,
      `page2: expected 3, got ${page2.body.memories.length}`
    );
    assert(page2.body.nextCursor === null, "page2: expected null nextCursor (last page)");

    const allIds = [
      ...page1.body.memories.map((m: any) => m.id),
      ...page2.body.memories.map((m: any) => m.id),
    ];
    const uniqueIds = new Set(allIds);
    assert(uniqueIds.size === 8, `expected 8 unique IDs, got ${uniqueIds.size}`);
  },
});

tests.push({
  name: "Invalid cursor returns 400",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", {
      scope,
      cursor: "not-valid-base64-json!",
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request", got "${res.body.error?.code}"`
    );
    assert(
      res.body.error?.message === "Invalid cursor",
      `expected message "Invalid cursor", got "${res.body.error?.message}"`
    );
  },
});

tests.push({
  name: "Superseded memories are excluded from list",
  fn: async () => {
    const superKey = `supersede_test_${Date.now()}`;
    const setRes = await apiCall("/v1/memories", {
      scope,
      key: superKey,
      value: "will be superseded",
    });
    assert(setRes.status === 200, `set: expected 200, got ${setRes.status}`);
    const memId = setRes.body.memories[0].id;

    await testDb`
      UPDATE wm_memories
      SET superseded_by = '00000000-0000-0000-0000-000000000001'::uuid
      WHERE id = ${memId}::uuid
    `;

    const listRes = await apiCall("/v1/memories/list", { scope, search: superKey });
    assert(listRes.status === 200, `list: expected 200, got ${listRes.status}`);
    const found = listRes.body.memories.some((m: any) => m.id === memId);
    assert(!found, "expected superseded memory to NOT appear in list");

    await testDb`UPDATE wm_memories SET superseded_by = NULL WHERE id = ${memId}::uuid`;
    await apiCall("/v1/memories/remove", { scope, key: superKey });
  },
});

// ── DELETE /v1/memories/:id tests ───────────────────────────────────────────

tests.push({
  name: "Delete memory by ID returns deleted: true",
  fn: async () => {
    const setRes = await apiCall("/v1/memories", {
      scope,
      key: "to_delete_by_id",
      value: "temp",
    });
    assert(setRes.status === 200, `set: expected 200, got ${setRes.status}`);
    const memId = setRes.body.memories[0].id;

    const delRes = await fetch(`${BASE_URL}/v1/memories/${memId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(delRes.status === 200, `delete: expected 200, got ${delRes.status}`);
    const delBody = (await delRes.json()) as any;
    assert(
      delBody.result?.deleted === true,
      `expected result.deleted: true, got ${JSON.stringify(delBody.result)}`
    );

    const getRes = await apiCall("/v1/memories/get", { scope, key: "to_delete_by_id" });
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
    const delBody = (await delRes.json()) as any;
    assert(
      delBody.result?.deleted === false,
      `expected result.deleted: false, got ${JSON.stringify(delBody.result)}`
    );
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
    const delBody = (await delRes.json()) as any;
    assert(delBody.error?.code === "invalid_request", `expected invalid_request`);
  },
});

// ── /v1/recall defaults tests ───────────────────────────────────────────────

tests.push({
  name: "Recall with defaults for nonexistent user returns defaults in context",
  fn: async () => {
    const res = await apiCall("/v1/recall", {
      scope: "recall_defaults_test_user",
      query: "hello",
      defaults: { plan: "pro", tier: "beta" },
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.context.includes("plan: pro"), `expected "plan: pro" in context`);
    assert(res.body.context.includes("tier: beta"), `expected "tier: beta" in context`);
    assert(res.body.memories.length === 0, `expected 0 memories (defaults are not real memories)`);
  },
});

// ── SDK register() + recall() defaults test ─────────────────────────────────

tests.push({
  name: "SDK register() defaults appear in recall() context",
  fn: async () => {
    const client = createClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
    client.register({ theme: "dark", language: "en" });
    const result = await client.recall({
      scope: "sdk_register_test_nonexistent_user",
      query: "hello",
    });
    assert(result.context.includes("theme: dark"), `expected "theme: dark" in context`);
    assert(result.context.includes("language: en"), `expected "language: en" in context`);
    assert(result.memories.length === 0, `expected 0 memories for nonexistent user`);
  },
});

// ── /v1/account/extraction-prompt tests ─────────────────────────────────────

tests.push({
  name: "Get extraction prompt returns default when unset",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(
      body.extractionPrompt?.source === "default",
      `expected source "default", got "${body.extractionPrompt?.source}"`
    );
    assert(
      body.extractionPrompt?.prompt === null,
      `expected null prompt, got "${body.extractionPrompt?.prompt}"`
    );
  },
});

tests.push({
  name: "[setup] Bump test account to pro for extraction prompt tests",
  fn: async () => {
    await updateTestAccount({ plan_tier: "pro" });
  },
});

tests.push({
  name: "Set custom extraction prompt",
  fn: async () => {
    const res = await apiCall("/v1/account/extraction-prompt", {
      prompt: "You are a custom extraction prompt for testing.",
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.extractionPrompt?.source === "custom",
      `expected source "custom", got "${res.body.extractionPrompt?.source}"`
    );
    assert(
      res.body.extractionPrompt?.prompt === "You are a custom extraction prompt for testing.",
      `expected prompt to match, got "${res.body.extractionPrompt?.prompt}"`
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
    assert(
      body.extractionPrompt?.source === "custom",
      `expected source "custom", got "${body.extractionPrompt?.source}"`
    );
    assert(
      body.extractionPrompt?.prompt === "You are a custom extraction prompt for testing.",
      `expected custom prompt text, got "${body.extractionPrompt?.prompt}"`
    );
  },
});

tests.push({
  name: "Reset extraction prompt returns result.reset: true",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(
      body.result?.reset === true,
      `expected result.reset: true, got ${JSON.stringify(body.result)}`
    );
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
    assert(
      body.extractionPrompt?.source === "default",
      `expected source "default" after reset, got "${body.extractionPrompt?.source}"`
    );
    assert(
      body.extractionPrompt?.prompt === null,
      `expected null prompt after reset, got "${body.extractionPrompt?.prompt}"`
    );
  },
});

tests.push({
  name: "Set extraction prompt validation rejects empty string",
  fn: async () => {
    const res = await apiCall("/v1/account/extraction-prompt", { prompt: "   " });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error?.code === "invalid_request", `expected error.code "invalid_request"`);
  },
});

tests.push({
  name: "[teardown] Restore test account to free tier after extraction prompt tests",
  fn: async () => {
    await updateTestAccount({ plan_tier: "free", extraction_prompt: null });
  },
});

// ── Cross-account ownership test (requires WITHMEMORY_API_KEY_B) ────────────

if (API_KEY_B) {
  tests.push({
    name: "Cross-account delete returns deleted: false (ownership boundary)",
    fn: async () => {
      const setRes = await apiCall("/v1/memories", {
        scope,
        key: "cross_acct_test",
        value: "secret",
      });
      assert(setRes.status === 200, `set: expected 200, got ${setRes.status}`);
      const memId = setRes.body.memories[0].id;

      const delRes = await fetch(`${BASE_URL}/v1/memories/${memId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${API_KEY_B}` },
      });
      assert(delRes.status === 200, `cross-account delete: expected 200, got ${delRes.status}`);
      const delBody = (await delRes.json()) as any;
      assert(
        delBody.result?.deleted === false,
        `expected result.deleted: false (Account B cannot delete Account A's memory), got ${JSON.stringify(delBody.result)}`
      );

      const getRes = await apiCall("/v1/memories/get", { scope, key: "cross_acct_test" });
      assert(
        getRes.body.memory !== null,
        "expected memory to still exist after cross-account delete attempt"
      );
      assert(
        getRes.body.memory.value === "secret",
        `expected value "secret", got "${getRes.body.memory.value}"`
      );

      const cleanupRes = await fetch(`${BASE_URL}/v1/memories/${memId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      assert(cleanupRes.status === 200, `cleanup delete: expected 200`);
      const cleanupBody = (await cleanupRes.json()) as any;
      assert(
        cleanupBody.result?.deleted === true,
        `cleanup: expected result.deleted: true, got ${JSON.stringify(cleanupBody.result)}`
      );
    },
  });
} else {
  console.log("\u26a0 Skipping cross-account ownership test (WITHMEMORY_API_KEY_B not set)");
}

// ── Plan enforcement tests ──────────────────────────────────────────────────
// These tests mutate account state (plan tier, memory limit) via direct DB
// access. Each case uses try/finally to guarantee teardown even on failure.

const quotaUserId = `e2e_quota_${Date.now()}`;

tests.push({
  name: "quota_exceeded on /v1/memories when memory limit reached",
  fn: async () => {
    for (let i = 1; i <= 3; i++) {
      await apiCall("/v1/memories/remove", { scope: quotaUserId, key: `quota_key_${i}` });
    }
    await apiCall("/v1/memories/remove", { scope: quotaUserId, key: "quota_key_4" });

    const [{ count: baseCount }] = await testDb`
      SELECT count(*)::int AS count FROM wm_memories
      WHERE account_id = ${testAccountId} AND superseded_by IS NULL
    `;
    await updateTestAccount({ memory_limit: baseCount + 10 });
    try {
      for (let i = 1; i <= 3; i++) {
        const res = await apiCall("/v1/memories", {
          scope: quotaUserId,
          key: `quota_key_${i}`,
          value: `value_${i}`,
        });
        assert(res.status === 200, `set ${i}/3: expected 200, got ${res.status}`);
      }

      const [{ count: currentCount }] = await testDb`
        SELECT count(*)::int AS count FROM wm_memories
        WHERE account_id = ${testAccountId} AND superseded_by IS NULL
      `;
      await updateTestAccount({ memory_limit: currentCount });

      const res = await apiCall("/v1/memories", {
        scope: quotaUserId,
        key: "quota_key_4",
        value: "should_fail",
      });
      assert(res.status === 403, `4th set: expected 403, got ${res.status}`);
      assert(
        res.body.error?.code === "quota_exceeded",
        `expected error.code "quota_exceeded", got "${res.body.error?.code}"`
      );
      assert(
        res.body.error?.details?.current === currentCount,
        `expected details.current === ${currentCount}, got ${res.body.error?.details?.current}`
      );
      assert(
        res.body.error?.details?.limit === currentCount,
        `expected details.limit === ${currentCount}, got ${res.body.error?.details?.limit}`
      );
    } finally {
      await updateTestAccount({ memory_limit: 1000 });
      for (let i = 1; i <= 3; i++) {
        await apiCall("/v1/memories/remove", {
          scope: quotaUserId,
          key: `quota_key_${i}`,
        });
      }
    }
  },
});

tests.push({
  name: "quota_exceeded on /v1/memories extraction path when account at limit",
  fn: async () => {
    await updateTestAccount({ memory_limit: 0 });
    try {
      const res = await apiCall("/v1/memories", {
        scope: quotaUserId,
        value: "My favorite color is blue.",
      });
      assert(res.status === 403, `expected 403, got ${res.status}`);
      assert(
        res.body.error?.code === "quota_exceeded",
        `expected error.code "quota_exceeded", got "${res.body.error?.code}"`
      );
    } finally {
      await updateTestAccount({ memory_limit: 1000 });
    }
  },
});

tests.push({
  name: "plan_required on custom extraction prompt with free tier",
  fn: async () => {
    const rows = await testDb`
      SELECT plan_tier FROM wm_accounts WHERE id = ${testAccountId}
    `;
    assert(rows[0].plan_tier === "free", `expected plan_tier "free", got "${rows[0].plan_tier}"`);

    const res = await apiCall("/v1/account/extraction-prompt", {
      prompt: "This should be rejected.",
    });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(
      res.body.error?.code === "plan_required",
      `expected error.code "plan_required", got "${res.body.error?.code}"`
    );
    assert(
      res.body.error?.details?.current_tier === "free",
      `expected details.current_tier "free"`
    );
    const requiredTiers = res.body.error?.details?.required_tiers;
    assert(
      Array.isArray(requiredTiers) &&
        requiredTiers.includes("pro") &&
        requiredTiers.includes("team") &&
        requiredTiers.includes("enterprise"),
      `expected required_tiers to include pro, team, enterprise`
    );
    const recovery = res.body.error?.details?.recovery_options;
    assert(
      Array.isArray(recovery) && recovery.length > 0,
      `expected recovery_options to be a non-empty array, got ${JSON.stringify(recovery)}`
    );
    assert(
      recovery.some((o: { action?: string }) => o.action === "upgrade_plan"),
      `expected recovery_options to include {action:"upgrade_plan"}, got ${JSON.stringify(recovery)}`
    );
  },
});

tests.push({
  name: "Custom extraction prompt succeeds on pro tier",
  fn: async () => {
    await updateTestAccount({ plan_tier: "pro" });
    try {
      const res = await apiCall("/v1/account/extraction-prompt", {
        prompt: "Pro-tier custom prompt for testing.",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(
        res.body.extractionPrompt?.source === "custom",
        `expected source "custom", got "${res.body.extractionPrompt?.source}"`
      );
      assert(
        res.body.extractionPrompt?.prompt === "Pro-tier custom prompt for testing.",
        `expected prompt to match, got "${res.body.extractionPrompt?.prompt}"`
      );

      const getRes = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const getBody = (await getRes.json()) as any;
      assert(
        getBody.extractionPrompt?.source === "custom",
        `GET: expected source "custom", got "${getBody.extractionPrompt?.source}"`
      );
      assert(
        getBody.extractionPrompt?.prompt === "Pro-tier custom prompt for testing.",
        `GET: expected prompt to match, got "${getBody.extractionPrompt?.prompt}"`
      );
    } finally {
      await updateTestAccount({ plan_tier: "free", extraction_prompt: null });
    }
  },
});

// ── threshold preset on /v1/recall ──────────────────────────────────────────
// Seed one memory highly related to the query and one clearly unrelated, then
// recall with strict (floor 0.4) and permissive (floor 0.1). Permissive must
// return at least as many as strict, and the mismatched seeds should produce
// at least one case where permissive returns more. Embeddings aren't
// deterministic to a decimal; we test the relationship, not exact counts.

const thresholdScope = `e2e_threshold_${Date.now()}`;

tests.push({
  name: "[setup] threshold: seed memories with a spread of topical distance",
  fn: async () => {
    // Strict (0.4) vs permissive (0.1) only diverges when at least one memory
    // lands in the (0.1, 0.4) cosine similarity band. Two seeds weren't
    // enough — both tended to fall on one side of the band depending on
    // phrasing. Five seeds with deliberately graded topical distance to the
    // food query make it very likely at least one sits in the band.
    const seeds: Array<{ key: string; value: string }> = [
      { key: "food_direct", value: "My favorite foods are pizza and pasta for dinner." },
      { key: "food_cuisine", value: "I love Italian cuisine, especially fresh handmade pasta." },
      { key: "food_adjacent", value: "I enjoy cooking simple meals on weekends with my family." },
      { key: "drink_routine", value: "I drink green tea with my breakfast every morning." },
      { key: "job_unrelated", value: "I work as a quantitative analyst at a hedge fund in Manhattan." },
    ];
    for (const s of seeds) {
      const res = await apiCall("/v1/memories", {
        scope: thresholdScope,
        key: s.key,
        value: s.value,
      });
      assert(res.status === 200, `seed ${s.key}: expected 200, got ${res.status}`);
    }
  },
});

tests.push({
  name: "threshold preset strict vs permissive produces different result counts",
  fn: async () => {
    const query = "What are my favorite foods to eat?";

    const strictRes = await apiCall("/v1/recall", {
      scope: thresholdScope,
      query,
      threshold: "strict",
      maxItems: 10,
    });
    assert(strictRes.status === 200, `strict: expected 200, got ${strictRes.status}`);

    const permissiveRes = await apiCall("/v1/recall", {
      scope: thresholdScope,
      query,
      threshold: "permissive",
      maxItems: 10,
    });
    assert(permissiveRes.status === 200, `permissive: expected 200, got ${permissiveRes.status}`);

    const strictCount = strictRes.body.memories?.length ?? 0;
    const permissiveCount = permissiveRes.body.memories?.length ?? 0;
    assert(
      permissiveCount >= strictCount,
      `expected permissive (${permissiveCount}) >= strict (${strictCount})`
    );
    assert(
      permissiveCount > strictCount,
      `expected permissive to keep at least one result strict drops; got strict=${strictCount} permissive=${permissiveCount}`
    );
  },
});

// ── importance on /v1/memories (explicit path) ──────────────────────────────
// importance is not returned in the Memory shape, so we verify via ranking
// effect: two near-identical memories differing only in importance should
// rank with the high-importance one first on recall.

const importanceScope = `e2e_importance_${Date.now()}`;

tests.push({
  name: "importance ranking effect: high-importance memory ranks above low-importance",
  fn: async () => {
    const highRes = await apiCall("/v1/memories", {
      scope: importanceScope,
      key: "fact_high",
      value: "The project launches on Tuesday next week.",
      importance: 0.9,
    });
    assert(highRes.status === 200, `high: expected 200, got ${highRes.status}`);

    const lowRes = await apiCall("/v1/memories", {
      scope: importanceScope,
      key: "fact_low",
      value: "The project launches on Tuesday next week.",
      importance: 0.1,
    });
    assert(lowRes.status === 200, `low: expected 200, got ${lowRes.status}`);

    const recallRes = await apiCall("/v1/recall", {
      scope: importanceScope,
      query: "When does the project launch?",
      maxItems: 10,
    });
    assert(recallRes.status === 200, `recall: expected 200, got ${recallRes.status}`);

    const memories = recallRes.body.memories as Array<{ key: string | null }>;
    const highIdx = memories.findIndex((m) => m.key === "fact_high");
    const lowIdx = memories.findIndex((m) => m.key === "fact_low");
    assert(highIdx !== -1, `expected fact_high to be in recall results`);
    assert(lowIdx !== -1, `expected fact_low to be in recall results`);
    assert(
      highIdx < lowIdx,
      `expected fact_high (idx ${highIdx}) to rank above fact_low (idx ${lowIdx})`
    );
  },
});

tests.push({
  name: "importance without key returns 400 invalid_request",
  fn: async () => {
    const res = await apiCall("/v1/memories", {
      scope: importanceScope,
      value: "Some extraction-path value that shouldn't accept importance.",
      importance: 0.5,
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request", got "${res.body.error?.code}"`
    );
  },
});

// ── issuedTo on /v1/auth/verify-code ────────────────────────────────────────
// Manual-verification-only: verify-code requires a real email round-trip
// (Resend sends a 6-digit code). Writing a full fixture just to verify one
// label parameter isn't worth the test weight. Verify by inspecting the
// wm_api_keys row after a real signup, or by curl against a known code:
//   curl -s -X POST $BASE/v1/auth/verify-code \
//     -d '{"email":"x@y","code":"123456","issuedTo":"my-label"}'
//   → then SELECT name, issued_to FROM wm_api_keys WHERE key_prefix = ...

// ── /v1/cache/claim response enhancements + scope enforcement ──────────────
// Create a cache, seed two entries, claim with the main API key, then verify
// (a) scope + containerKey are present, (b) the auto-minted key can recall,
// (c) the auto-minted key is rejected 403 insufficient_scope on write,
// (d) the same on DELETE /v1/memories/:id, (e) container management is
// closed to this key, (f) the key's label shows via whoami, (g) a second
// claim returns 409 with the one-shot key wording.

let claimRawToken: string;
let claimClaimToken: string;
let claimContainerKey: string;
let claimContainerScope: string;

tests.push({
  name: "[setup] cache.claim: seed a cache with two entries",
  fn: async () => {
    // POST /v1/cache is unauthenticated and rate-limited at 3 caches per IP
    // per 24h. Plenty for routine E2E runs; hammering will eventually 429.
    const createRes = await fetch(`${BASE_URL}/v1/cache`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 3600 }),
    });
    assert(createRes.status === 201, `cache create: expected 201, got ${createRes.status}`);
    const createBody = (await createRes.json()) as any;
    assert(typeof createBody.cache?.rawToken === "string", "rawToken missing");
    assert(typeof createBody.cache?.claimToken === "string", "claimToken missing");
    claimRawToken = createBody.cache.rawToken;
    claimClaimToken = createBody.cache.claimToken;

    for (const [k, v] of [
      ["pref_color", "I prefer the color blue."],
      ["pref_language", "I prefer English over French."],
    ] as const) {
      const setRes = await fetch(`${BASE_URL}/v1/cache/set`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${claimRawToken}`,
        },
        body: JSON.stringify({ key: k, value: v }),
      });
      assert(setRes.status === 200, `cache set ${k}: expected 200, got ${setRes.status}`);
    }
  },
});

tests.push({
  name: "cache.claim response includes scope and containerKey",
  fn: async () => {
    const res = await apiCall("/v1/cache/claim", { claimToken: claimClaimToken });
    assert(res.status === 200, `claim: expected 200, got ${res.status} body=${JSON.stringify(res.body)}`);
    assert(res.body.result?.claimed === true, `expected claimed=true`);
    assert(
      typeof res.body.result?.containerId === "string" && res.body.result.containerId.length > 0,
      `containerId missing`
    );
    assert(
      res.body.result?.memoriesCreated === 2,
      `expected memoriesCreated=2, got ${res.body.result?.memoriesCreated}`
    );
    assert(
      typeof res.body.result?.scope === "string" && res.body.result.scope.startsWith("cache-"),
      `expected scope starting with "cache-", got "${res.body.result?.scope}"`
    );
    assert(
      typeof res.body.result?.containerKey === "string" &&
        res.body.result.containerKey.startsWith("wm_live_"),
      `expected containerKey starting with wm_live_, got "${res.body.result?.containerKey}"`
    );
    claimContainerKey = res.body.result.containerKey;
    claimContainerScope = res.body.result.scope;
  },
});

tests.push({
  name: "Auto-minted container key can recall against returned scope",
  fn: async () => {
    const res = await fetch(`${BASE_URL}/v1/recall`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${claimContainerKey}`,
      },
      body: JSON.stringify({
        scope: claimContainerScope,
        query: "What color do I prefer?",
        maxItems: 10,
      }),
    });
    assert(res.status === 200, `recall: expected 200, got ${res.status}`);
    const body = (await res.json()) as any;
    const memKeys = (body.memories ?? []).map((m: { key: string | null }) => m.key);
    assert(
      memKeys.includes("pref_color"),
      `expected pref_color in recalled memories, got ${JSON.stringify(memKeys)}`
    );
  },
});

tests.push({
  name: "Read-only key cannot write via POST /v1/memories (insufficient_scope)",
  fn: async () => {
    const res = await fetch(`${BASE_URL}/v1/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${claimContainerKey}`,
      },
      body: JSON.stringify({
        scope: claimContainerScope,
        key: "scope_gap_probe",
        value: "This write must be rejected with 403 insufficient_scope.",
      }),
    });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    const body = (await res.json()) as any;
    assert(
      body.error?.code === "insufficient_scope",
      `expected error.code "insufficient_scope", got "${body.error?.code}"`
    );
    const required = body.error?.details?.required;
    assert(
      Array.isArray(required) && required.includes("memory:write"),
      `expected details.required to include "memory:write", got ${JSON.stringify(required)}`
    );
  },
});

tests.push({
  name: "Read-only key cannot DELETE /v1/memories/:id (insufficient_scope)",
  fn: async () => {
    // Any UUID works for the scope check — it fires before the row lookup.
    const res = await fetch(
      `${BASE_URL}/v1/memories/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${claimContainerKey}` },
      }
    );
    assert(res.status === 403, `expected 403, got ${res.status}`);
    const body = (await res.json()) as any;
    assert(
      body.error?.code === "insufficient_scope",
      `expected error.code "insufficient_scope", got "${body.error?.code}"`
    );
  },
});

tests.push({
  name: "Read-only key cannot manage containers (insufficient_scope)",
  fn: async () => {
    // The auto-minted key is under the container (parentAccountId != null),
    // so requireAdminScope returns 401 unauthorized (account-hierarchy
    // check) BEFORE the scope check fires. This test asserts the route is
    // gated; the specific code depends on which check runs first. Accept
    // either 401 unauthorized (hierarchy) or 403 insufficient_scope (scope)
    // — both prove the route is closed to this key. Report which fired.
    const res = await fetch(`${BASE_URL}/v1/containers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${claimContainerKey}`,
      },
      body: JSON.stringify({ name: "should-be-rejected" }),
    });
    assert(
      res.status === 401 || res.status === 403,
      `expected 401 or 403, got ${res.status}`
    );
    const body = (await res.json()) as any;
    assert(
      body.error?.code === "unauthorized" || body.error?.code === "insufficient_scope",
      `expected code "unauthorized" or "insufficient_scope", got "${body.error?.code}"`
    );
  },
});

tests.push({
  name: "whoami with container key returns key.name starting with cache-claim/",
  fn: async () => {
    const res = await fetch(`${BASE_URL}/v1/account`, {
      method: "GET",
      headers: { Authorization: `Bearer ${claimContainerKey}` },
    });
    assert(res.status === 200, `whoami: expected 200, got ${res.status}`);
    const body = (await res.json()) as any;
    assert(
      typeof body.key?.name === "string" && body.key.name.startsWith("cache-claim/"),
      `expected key.name to start with "cache-claim/", got "${body.key?.name}"`
    );
  },
});

tests.push({
  name: "Second claim of same token returns 409 with one-shot key wording",
  fn: async () => {
    const res = await apiCall("/v1/cache/claim", { claimToken: claimClaimToken });
    assert(res.status === 409, `expected 409, got ${res.status}`);
    assert(
      res.body.error?.code === "already_claimed",
      `expected code "already_claimed", got "${res.body.error?.code}"`
    );
    const msg = res.body.error?.message ?? "";
    assert(
      msg.includes("cannot be re-issued"),
      `expected message to include "cannot be re-issued", got "${msg}"`
    );
    assert(
      msg.includes("POST /v1/containers/"),
      `expected message to include recovery path "POST /v1/containers/", got "${msg}"`
    );
  },
});

// ── API call metering tests ─────────────────────────────────────────────────

tests.push({
  name: "/v1/account/usage exposes apiCallsThisPeriod and monthlyApiCallLimit",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/usage`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(
      typeof body.usage?.apiCallsThisPeriod === "number",
      `expected number apiCallsThisPeriod, got ${typeof body.usage?.apiCallsThisPeriod}`
    );
    assert(
      typeof body.usage?.monthlyApiCallLimit === "number",
      `expected number monthlyApiCallLimit, got ${typeof body.usage?.monthlyApiCallLimit}`
    );
    assert(
      typeof body.usage?.apiCallsResetAt === "string",
      `expected string apiCallsResetAt, got ${typeof body.usage?.apiCallsResetAt}`
    );
    assert(
      body.usage.apiCallsThisPeriod >= 0,
      `expected non-negative apiCallsThisPeriod, got ${body.usage.apiCallsThisPeriod}`
    );
  },
});

tests.push({
  name: "/v1/account/billing exposes apiCallsThisPeriod and monthlyApiCallLimit",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/account/billing`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = (await response.json()) as any;
    assert(
      typeof body.billing?.usage?.apiCallsThisPeriod === "number",
      `expected number apiCallsThisPeriod, got ${typeof body.billing?.usage?.apiCallsThisPeriod}`
    );
    assert(
      typeof body.billing?.usage?.monthlyApiCallLimit === "number",
      `expected number monthlyApiCallLimit, got ${typeof body.billing?.usage?.monthlyApiCallLimit}`
    );
    assert(
      typeof body.billing?.usage?.apiCallsResetAt === "string",
      `expected string apiCallsResetAt, got ${typeof body.billing?.usage?.apiCallsResetAt}`
    );
  },
});

async function main() {
  const totalStart = performance.now();
  let passed = 0;
  let failed = 0;

  testAccountId = await resolveTestAccountId();

  console.log(`\n\u25b6 Running WithMemory E2E tests`);
  console.log(`  Base URL:    ${BASE_URL}`);
  console.log(`  Scope:       ${scope}`);
  console.log(`  Account ID:  ${testAccountId}\n`);

  try {
    for (const test of tests) {
      const start = performance.now();
      try {
        await test.fn();
        const ms = Math.round(performance.now() - start);
        console.log(`\u2713 ${test.name} (${ms}ms)`);
        passed++;
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        console.log(`\u2717 ${test.name} (${ms}ms)`);
        console.log(`  ${err instanceof Error ? err.message : err}\n`);
        failed++;
        break;
      }
    }
  } finally {
    try {
      await updateTestAccount({
        plan_tier: "free",
        extraction_prompt: null,
        memory_limit: 1000,
      });
    } catch (e) {
      console.error("WARNING: final account cleanup failed:", e);
    }
    await testDb.end();
  }

  const totalMs = ((performance.now() - totalStart) / 1000).toFixed(1);
  console.log(
    `\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`
  );
  if (failed === 0) {
    console.log(`  ${passed} tests passed (${totalMs}s)`);
  } else {
    console.log(`  ${failed} of ${passed + failed} tests failed`);
  }
  console.log(
    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`
  );

  process.exit(failed > 0 ? 1 : 0);
}

main();
