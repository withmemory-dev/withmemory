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

const forScope = `e2e_test_${Date.now()}`;

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
    const res = await apiCall("/v1/recall", { forScope, query: "hello" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.context === "", `expected empty context, got "${res.body.context}"`);
    assert(res.body.memories.length === 0, `expected 0 memories, got ${res.body.memories.length}`);
  },
});

tests.push({
  name: "Set first memory: name",
  fn: async () => {
    const res = await apiCall("/v1/set", { forScope, forKey: "name", value: "Andrew" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory.source === "explicit", `expected source "explicit"`);
    assert(res.body.memory.forKey === "name", `expected key "name"`);
    assert(res.body.memory.value === "Andrew", `expected value "Andrew"`);
    assert(res.body.memory.forScope === forScope, `expected forScope "${forScope}"`);
    firstMemoryId = res.body.memory.id;
  },
});

tests.push({
  name: "Set second memory: role",
  fn: async () => {
    const res = await apiCall("/v1/set", { forScope, forKey: "role", value: "engineer" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory.forKey === "role", `expected key "role"`);
    assert(res.body.memory.value === "engineer", `expected value "engineer"`);
  },
});

tests.push({
  name: "Set third memory: subscription",
  fn: async () => {
    const res = await apiCall("/v1/set", { forScope, forKey: "subscription", value: "pro" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory.forKey === "subscription", `expected key "subscription"`);
    assert(res.body.memory.value === "pro", `expected value "pro"`);
  },
});

tests.push({
  name: "Recall returns all three memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { forScope, query: "tell me about myself" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 3, `expected 3 memories, got ${res.body.memories.length}`);
    assert(res.body.context.length > 0, "expected non-empty context");
    assert(res.body.context.includes("name: Andrew"), `context missing "name: Andrew"`);
    assert(
      res.body.context.includes("role: engineer"),
      `context missing "role: engineer"`
    );
    assert(
      res.body.context.includes("subscription: pro"),
      `context missing "subscription: pro"`
    );
    // Verify all three keys are present (order depends on semantic ranking)
    const keys = new Set(res.body.memories.map((m: any) => m.forKey));
    assert(keys.has("subscription"), `missing forKey "subscription"`);
    assert(keys.has("role"), `missing forKey "role"`);
    assert(keys.has("name"), `missing forKey "name"`);
  },
});

tests.push({
  name: "Recall with maxItems=2 returns 2 memories",
  fn: async () => {
    const res = await apiCall("/v1/recall", { forScope, query: "hi", maxItems: 2 });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length === 2, `expected 2 memories, got ${res.body.memories.length}`);
  },
});

tests.push({
  name: "Upsert updates existing memory",
  fn: async () => {
    const res = await apiCall("/v1/set", { forScope, forKey: "name", value: "Andrew Gierke" });
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
    const res = await apiCall("/v1/recall", { forScope, query: "who am i" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const nameMem = res.body.memories.find((m: any) => m.forKey === "name");
    assert(nameMem !== undefined, "expected to find name memory in recall");
    assert(nameMem.value === "Andrew Gierke", `expected value "Andrew Gierke", got "${nameMem.value}"`);
  },
});

tests.push({
  name: "Auth failure returns 401",
  fn: async () => {
    const res = await apiCall(
      "/v1/set",
      { forScope, forKey: "x", value: "y" },
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
    const res = await apiCall("/v1/set", { forScope: "x" });
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
    const res = await apiCall("/v1/get", { forScope, forKey: "name" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory !== null, "expected memory to be non-null");
    assert(res.body.memory.forKey === "name", `expected forKey "name", got "${res.body.memory.forKey}"`);
    assert(
      res.body.memory.value === "Andrew Gierke",
      `expected value "Andrew Gierke", got "${res.body.memory.value}"`
    );
  },
});

tests.push({
  name: "Get nonexistent key returns null memory",
  fn: async () => {
    const res = await apiCall("/v1/get", { forScope, forKey: "nonexistent_key" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory === null, `expected null memory, got ${JSON.stringify(res.body.memory)}`);
  },
});

tests.push({
  name: "Get for nonexistent user returns null memory",
  fn: async () => {
    const res = await apiCall("/v1/get", { forScope: "no_such_user_ever", forKey: "name" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memory === null, `expected null memory`);
  },
});

// ── /v1/remove tests ──────────────────────────────────────────────────────────

tests.push({
  name: "Remove existing memory returns deleted: true",
  fn: async () => {
    // Set a throwaway memory to remove
    await apiCall("/v1/set", { forScope, forKey: "to_delete", value: "temporary" });
    const res = await apiCall("/v1/remove", { forScope, forKey: "to_delete" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.deleted === true, `expected deleted: true, got ${res.body.deleted}`);
    // Verify it's gone
    const check = await apiCall("/v1/get", { forScope, forKey: "to_delete" });
    assert(check.body.memory === null, "expected memory to be gone after remove");
  },
});

tests.push({
  name: "Remove nonexistent key returns deleted: false",
  fn: async () => {
    const res = await apiCall("/v1/remove", { forScope, forKey: "never_existed" });
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
    const res = await apiCall("/v1/nonexistent", { forScope });
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
      forScope,
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
      forScope,
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
      forScope,
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
    const res = await apiCall("/v1/commit", { forScope });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error?.code === "invalid_request",
      `expected error.code "invalid_request"`
    );
  },
});

// ── /v1/memories/list tests ──────────────────────────────────────────────────

tests.push({
  name: "List memories for user with memories",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { forScope });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array in envelope");
    assert(res.body.nextCursor === null || typeof res.body.nextCursor === "string", "expected nextCursor");
    // User should have at least the 3 memories from set tests (name, role, subscription)
    assert(res.body.memories.length >= 3, `expected >= 3 memories, got ${res.body.memories.length}`);
    // Verify Memory shape
    const first = res.body.memories[0];
    assert(typeof first.id === "string", "expected id string");
    assert(typeof first.value === "string", "expected value string");
    assert(typeof first.source === "string", "expected source string");
    assert(typeof first.forScope === "string", "expected forScope string");
  },
});

tests.push({
  name: "List memories for nonexistent user returns empty",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { forScope: "no_such_user_ever_memories" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array");
    assert(res.body.memories.length === 0, `expected 0 memories`);
    assert(res.body.nextCursor === null, "expected null nextCursor");
  },
});

tests.push({
  name: "Account-wide listing returns memories across users",
  fn: async () => {
    // No forScope filter — should return all memories for the account
    const res = await apiCall("/v1/memories/list", {});
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.memories), "expected memories array");
    // Should include at least the 3 memories from the test forScope
    assert(res.body.memories.length >= 3, `expected >= 3 memories, got ${res.body.memories.length}`);
  },
});

tests.push({
  name: "Source filter returns only explicit memories",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { forScope, source: "explicit" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    for (const m of res.body.memories) {
      assert(m.source === "explicit", `expected source "explicit", got "${m.source}"`);
    }
  },
});

tests.push({
  name: "Search filter matches value content",
  fn: async () => {
    // Set a memory with a unique searchable value
    const searchKey = `search_test_${Date.now()}`;
    await apiCall("/v1/set", { forScope, forKey: searchKey, value: "xylophone_uniquetoken_987" });
    const res = await apiCall("/v1/memories/list", { forScope, search: "xylophone_uniquetoken" });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories.length >= 1, `expected >= 1 search result, got ${res.body.memories.length}`);
    const found = res.body.memories.some((m: any) => m.value === "xylophone_uniquetoken_987");
    assert(found, "expected to find memory with the unique search value");
    // Cleanup
    await apiCall("/v1/remove", { forScope, forKey: searchKey });
  },
});

tests.push({
  name: "includeTotal returns total count",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { forScope, includeTotal: true });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(typeof res.body.total === "number", `expected total to be a number, got ${typeof res.body.total}`);
    assert(res.body.total >= 3, `expected total >= 3, got ${res.body.total}`);
  },
});

tests.push({
  name: "includeTotal omitted when not requested",
  fn: async () => {
    const res = await apiCall("/v1/memories/list", { forScope });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(!("total" in res.body), `expected total to be absent, but it was present`);
  },
});

const paginationUserId = `e2e_pagination_${Date.now()}`;

tests.push({
  name: "Cursor pagination: create test data and paginate",
  fn: async () => {
    // Create 8 memories for pagination testing
    for (let i = 1; i <= 8; i++) {
      const res = await apiCall("/v1/set", {
        forScope: paginationUserId,
        key: `page_key_${String(i).padStart(2, "0")}`,
        value: `page_value_${i}`,
      });
      assert(res.status === 200, `set ${i}/8: expected 200, got ${res.status}`);
    }

    // Page 1: limit 5
    const page1 = await apiCall("/v1/memories/list", { forScope: paginationUserId, limit: 5 });
    assert(page1.status === 200, `page1: expected 200, got ${page1.status}`);
    assert(page1.body.memories.length === 5, `page1: expected 5, got ${page1.body.memories.length}`);
    assert(page1.body.nextCursor !== null, "page1: expected non-null nextCursor");

    // Page 2: use the cursor
    const page2 = await apiCall("/v1/memories/list", {
      forScope: paginationUserId,
      limit: 5,
      cursor: page1.body.nextCursor,
    });
    assert(page2.status === 200, `page2: expected 200, got ${page2.status}`);
    assert(page2.body.memories.length === 3, `page2: expected 3, got ${page2.body.memories.length}`);
    assert(page2.body.nextCursor === null, "page2: expected null nextCursor (last page)");

    // Verify no duplicates between pages
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
    const res = await apiCall("/v1/memories/list", { forScope, cursor: "not-valid-base64-json!" });
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
    // Create a memory, then mark it superseded via direct DB
    const superKey = `supersede_test_${Date.now()}`;
    const setRes = await apiCall("/v1/set", { forScope, forKey: superKey, value: "will be superseded" });
    assert(setRes.status === 200, `set: expected 200, got ${setRes.status}`);
    const memId = setRes.body.memory.id;

    // Mark as superseded via direct DB (use a dummy UUID)
    await testDb`
      UPDATE wm_memories
      SET superseded_by = '00000000-0000-0000-0000-000000000001'::uuid
      WHERE id = ${memId}::uuid
    `;

    // Verify it's NOT in the list
    const listRes = await apiCall("/v1/memories/list", { forScope, search: superKey });
    assert(listRes.status === 200, `list: expected 200, got ${listRes.status}`);
    const found = listRes.body.memories.some((m: any) => m.id === memId);
    assert(!found, "expected superseded memory to NOT appear in list");

    // Cleanup: delete (won't match since superseded, but clean up by unsuperseding first)
    await testDb`UPDATE wm_memories SET superseded_by = NULL WHERE id = ${memId}::uuid`;
    await apiCall("/v1/remove", { forScope, forKey: superKey });
  },
});

tests.push({
  name: "Old POST /v1/memories returns 404 (breaking change)",
  fn: async () => {
    const res = await apiCall("/v1/memories", { forScope });
    assert(res.status === 404, `expected 404 for old route, got ${res.status}`);
    assert(
      res.body.error?.code === "not_found",
      `expected error.code "not_found", got "${res.body.error?.code}"`
    );
  },
});

// ── DELETE /v1/memories/:id tests ────────────────────────────────────────────

tests.push({
  name: "Delete memory by ID returns deleted: true",
  fn: async () => {
    // Set a throwaway memory, then delete by ID
    const setRes = await apiCall("/v1/set", { forScope, forKey: "to_delete_by_id", value: "temp" });
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
    const getRes = await apiCall("/v1/get", { forScope, forKey: "to_delete_by_id" });
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
  name: "Recall with defaults for nonexistent user returns defaults in context",
  fn: async () => {
    const res = await apiCall("/v1/recall", {
      forScope: "recall_defaults_test_user",
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
      forScope: "sdk_register_test_nonexistent_user",
      query: "hello",
    });
    assert(result.context.includes("theme: dark"), `expected "theme: dark" in context`);
    assert(
      result.context.includes("language: en"),
      `expected "language: en" in context`
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

tests.push({
  name: "[teardown] Restore test account to free tier after extraction prompt tests",
  fn: async () => {
    await updateTestAccount({ plan_tier: "free", extraction_prompt: null });
  },
});

// ─�� Cross-account ownership test (requires WITHMEMORY_API_KEY_B) ────────���────

if (API_KEY_B) {
  tests.push({
    name: "Cross-account delete returns deleted: false (ownership boundary)",
    fn: async () => {
      // 1. Create a memory under Account A
      const setRes = await apiCall("/v1/set", { forScope, forKey: "cross_acct_test", value: "secret" });
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
      const getRes = await apiCall("/v1/get", { forScope, forKey: "cross_acct_test" });
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

// ── Plan enforcement tests ──────────────��───────────────────────────────────
// These tests mutate account state (plan tier, memory limit) via direct DB
// access. Each case uses try/finally to guarantee teardown even on failure.

const quotaUserId = `e2e_quota_${Date.now()}`;

tests.push({
  name: "quota_exceeded on /v1/set when memory limit reached",
  fn: async () => {
    // First, clean up any stale quota test memories from prior failed runs
    for (let i = 1; i <= 3; i++) {
      await apiCall("/v1/remove", { forScope: quotaUserId, forKey: `quota_key_${i}` });
    }
    await apiCall("/v1/remove", { forScope: quotaUserId, forKey: "quota_key_4" });

    // Query current memory count so we can set the limit relative to it.
    // The account already has memories from earlier tests in this run,
    // and async extraction from commit tests may still be landing.
    // Use headroom of +10 so the 3 creates succeed even if a few
    // extraction results land in the gap, then tighten to +3 for the
    // rejection test.
    const [{ count: baseCount }] = await testDb`
      SELECT count(*)::int AS count FROM wm_memories
      WHERE account_id = ${testAccountId} AND superseded_by IS NULL
    `;
    await updateTestAccount({ memory_limit: baseCount + 10 });
    try {
      // Create 3 memories — should succeed
      for (let i = 1; i <= 3; i++) {
        const res = await apiCall("/v1/set", {
          forScope: quotaUserId,
          forKey: `quota_key_${i}`,
          value: `value_${i}`,
        });
        assert(res.status === 200, `set ${i}/3: expected 200, got ${res.status}`);
      }

      // Now tighten the limit to exactly the current count so the next
      // write is rejected. Re-count to account for any async writes.
      const [{ count: currentCount }] = await testDb`
        SELECT count(*)::int AS count FROM wm_memories
        WHERE account_id = ${testAccountId} AND superseded_by IS NULL
      `;
      await updateTestAccount({ memory_limit: currentCount });

      // 4th should be rejected — limit is exactly the current count
      const res = await apiCall("/v1/set", {
        forScope: quotaUserId,
        forKey: "quota_key_4",
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
      // Teardown: restore limit and clean up memories via remove
      await updateTestAccount({ memory_limit: 1000 });
      for (let i = 1; i <= 3; i++) {
        await apiCall("/v1/remove", { forScope: quotaUserId, forKey: `quota_key_${i}` });
      }
    }
  },
});

tests.push({
  name: "quota_exceeded on /v1/commit when account at limit",
  fn: async () => {
    await updateTestAccount({ memory_limit: 0 });
    try {
      const res = await apiCall("/v1/commit", {
        forScope: quotaUserId,
        input: "My favorite color is blue.",
        output: "Got it!",
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
    // Sanity check: account should already be free from earlier teardown
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
      assert(res.body.source === "custom", `expected source "custom"`);
      assert(
        res.body.prompt === "Pro-tier custom prompt for testing.",
        `expected prompt to match`
      );

      // Verify via GET
      const getRes = await fetch(`${BASE_URL}/v1/account/extraction-prompt`, {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const getBody = (await getRes.json()) as any;
      assert(getBody.source === "custom", `GET: expected source "custom"`);
      assert(
        getBody.prompt === "Pro-tier custom prompt for testing.",
        `GET: expected prompt to match`
      );
    } finally {
      // Teardown: restore free tier and clear prompt
      await updateTestAccount({ plan_tier: "free", extraction_prompt: null });
    }
  },
});

// ── Backward compatibility: deprecation warning on old parameter names ───────

tests.push({
  name: "Old parameter names (userId, key) emit X-Deprecation-Warning header",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/set`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ userId: forScope, key: "compat_test", value: "backward compat" }),
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const warning = response.headers.get("x-deprecation-warning");
    assert(warning !== null, "expected X-Deprecation-Warning header");
    assert(warning!.includes("forScope"), `expected warning to mention "forScope", got: ${warning}`);
    assert(warning!.includes("forKey"), `expected warning to mention "forKey", got: ${warning}`);
    // Clean up
    await apiCall("/v1/remove", { forScope, forKey: "compat_test" });
  },
});

// ── Backward compatibility: old /v1/sub-accounts route returns 308 redirect ──

tests.push({
  name: "Old /v1/sub-accounts route returns 308 redirect to /v1/containers",
  fn: async () => {
    const response = await fetch(`${BASE_URL}/v1/sub-accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ name: "redirect-test" }),
      redirect: "manual",
    });
    assert(response.status === 308, `expected 308, got ${response.status}`);
    const location = response.headers.get("location");
    assert(location !== null, "expected Location header");
    assert(location!.includes("/v1/containers"), `expected Location to include "/v1/containers", got: ${location}`);
  },
});

async function main() {
  const totalStart = performance.now();
  let passed = 0;
  let failed = 0;

  // Resolve account ID for plan enforcement tests
  testAccountId = await resolveTestAccountId();

  console.log(`\n▶ Running WithMemory E2E tests`);
  console.log(`  Base URL:    ${BASE_URL}`);
  console.log(`  Scope:       ${forScope}`);
  console.log(`  Account ID:  ${testAccountId}\n`);

  try {
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
  } finally {
    // Guaranteed cleanup: account back to known-good state regardless of
    // test failures, uncaught exceptions, or runner breaking out mid-loop.
    // Prevents stale plan_tier='pro' from cascading into subsequent runs.
    try {
      await updateTestAccount({ plan_tier: "free", extraction_prompt: null, memory_limit: 1000 });
    } catch (e) {
      console.error("WARNING: final account cleanup failed:", e);
    }
    await testDb.end();
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
