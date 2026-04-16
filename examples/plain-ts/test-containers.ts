/**
 * E2E tests for the Containers API (Path B).
 *
 * Requires:
 *   WITHMEMORY_BASE_URL  — server URL (default: http://localhost:8787)
 *   WITHMEMORY_API_KEY   — API key for a test account (will be promoted to Pro during tests)
 *   WITHMEMORY_API_KEY_B — API key for a SECOND test account (for cross-account isolation)
 *   DATABASE_URL         — direct Postgres URL for test state mutations
 *
 * Run:
 *   npx tsx test-containers.ts
 */

import pgPkg from "postgres";

const BASE_URL = process.env.WITHMEMORY_BASE_URL ?? "http://localhost:8787";
const API_KEY = process.env.WITHMEMORY_API_KEY;
const API_KEY_B = process.env.WITHMEMORY_API_KEY_B;
const DATABASE_URL = process.env.DATABASE_URL;

if (!API_KEY) {
  console.error("ERROR: WITHMEMORY_API_KEY is required.");
  process.exit(1);
}
if (!API_KEY_B) {
  console.error("ERROR: WITHMEMORY_API_KEY_B is required (second account for isolation tests).");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required.");
  process.exit(1);
}

// ── DB helper ──────────────────────────────────────────────────────────────
const testDb = pgPkg(DATABASE_URL, { max: 1, idle_timeout: 5 });

async function resolveAccountId(apiKey: string): Promise<string> {
  const rows = await testDb`
    SELECT a.id
    FROM wm_api_keys k
    JOIN wm_accounts a ON k.account_id = a.id
    WHERE ${apiKey} LIKE key_prefix || '%'
      AND k.revoked_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error("No account found for API key");
  return rows[0].id;
}

async function updateAccount(
  accountId: string,
  patch: { plan_tier?: string; memory_limit?: number }
): Promise<void> {
  if (patch.plan_tier !== undefined) {
    await testDb`UPDATE wm_accounts SET plan_tier = ${patch.plan_tier} WHERE id = ${accountId}`;
  }
  if (patch.memory_limit !== undefined) {
    await testDb`UPDATE wm_accounts SET memory_limit = ${patch.memory_limit} WHERE id = ${accountId}`;
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
async function apiCall(
  method: string,
  path: string,
  body: unknown | undefined,
  options: { key?: string } = {}
): Promise<{ status: number; body: any }> {
  const key = options.key ?? API_KEY;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── Test registry ──────────────────────────────────────────────────────────
type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [];

// ── Shared state across tests ──────────────────────────────────────────────
let accountIdA: string;
let accountIdB: string;
let containerId: string;
let containerKeyId: string;
let containerRawKey: string;

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Free-tier plan gate
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Free-tier account cannot create containers (403 plan_required)",
  fn: async () => {
    // Account A starts on free tier (default)
    const res = await apiCall("POST", "/v1/containers", { name: "should-fail" });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(
      res.body.error.code === "plan_required",
      `expected plan_required, got ${res.body.error.code}`
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Promote to Pro, create container
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Pro-tier account can create a container (201)",
  fn: async () => {
    await updateAccount(accountIdA, { plan_tier: "pro" });
    const res = await apiCall("POST", "/v1/containers", {
      name: "agent-alpha",
      metadata: { purpose: "testing", version: 1 },
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert(res.body.container.parentAccountId === accountIdA, "parentAccountId mismatch");
    assert(res.body.container.name === "agent-alpha", "name mismatch");
    assert(res.body.container.metadata.purpose === "testing", "metadata mismatch");
    assert(res.body.container.planTier === "pro", "planTier should inherit");
    assert(
      typeof res.body.request_id === "string" && res.body.request_id.length > 0,
      `expected request_id in response body`
    );
    containerId = res.body.container.id;
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Container limit enforcement
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Container limit enforced at Pro tier cap (403 container_limit_exceeded)",
  fn: async () => {
    // Create 9 more containers (total = 10, the Pro limit)
    for (let i = 2; i <= 10; i++) {
      const res = await apiCall("POST", "/v1/containers", { name: `agent-${i}` });
      assert(res.status === 201, `container ${i}: expected 201, got ${res.status}`);
    }
    // 11th should fail
    const res = await apiCall("POST", "/v1/containers", { name: "agent-11" });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    assert(
      res.body.error.code === "container_limit_exceeded",
      `expected container_limit_exceeded, got ${res.body.error.code}`
    );
    assert(
      res.body.error.details.current === 10,
      `expected current=10, got ${res.body.error.details.current}`
    );
    assert(
      res.body.error.details.limit === 10,
      `expected limit=10, got ${res.body.error.details.limit}`
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 4: Mint a container key
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Mint a key for a container (201 with rawKey)",
  fn: async () => {
    const res = await apiCall("POST", `/v1/containers/${containerId}/keys`, {
      issuedTo: "test-agent-session",
      scopes: "memory:read,memory:write",
    });
    assert(res.status === 201, `expected 201, got ${res.status}`);
    assert(res.body.rawKey.startsWith("wm_live_"), "rawKey should start with wm_live_");
    assert(res.body.key.scopes === "memory:read,memory:write", "scopes mismatch");
    assert(res.body.key.issuedTo === "test-agent-session", "issuedTo mismatch");
    assert(res.body.key.accountId === containerId, "accountId mismatch");
    // Verify keyHash is NOT leaked in the response
    assert(res.body.key.keyHash === undefined, "keyHash should not be in response");
    containerKeyId = res.body.key.id;
    containerRawKey = res.body.rawKey;
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5: account:admin scope blocked on container keys
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Cannot mint container key with account:admin scope (400)",
  fn: async () => {
    const res = await apiCall("POST", `/v1/containers/${containerId}/keys`, {
      issuedTo: "bad-agent",
      scopes: "memory:read,account:admin",
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error.code === "invalid_request",
      `expected invalid_request, got ${res.body.error.code}`
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Container key can store a memory
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Container key stores memory on the container, not the parent",
  fn: async () => {
    const res = await apiCall(
      "POST",
      "/v1/memories",
      {
        scope: "agent-user-1",
        key: "preference",
        value: "dark-mode",
      },
      { key: containerRawKey }
    );
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.memories[0].value === "dark-mode", "value mismatch");

    // Verify in DB that the memory is on the container
    const rows = await testDb`
      SELECT account_id FROM wm_memories WHERE id = ${res.body.memories[0].id}
    `;
    assert(rows.length === 1, "memory not found in DB");
    assert(rows[0].account_id === containerId, "memory stored on wrong account");
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 7: Scope enforcement — container key cannot call container mgmt
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Container key (memory:read,memory:write) cannot call /v1/containers (401)",
  fn: async () => {
    const res = await apiCall(
      "POST",
      "/v1/containers",
      { name: "nope" },
      {
        key: containerRawKey,
      }
    );
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(
      res.body.error.code === "unauthorized",
      `expected unauthorized, got ${res.body.error.code}`
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 8: Quota inheritance
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Quota inheritance: container memories count against parent limit",
  fn: async () => {
    // Count current active memories across parent + all containers, then set
    // the limit to current+1 so exactly one more write succeeds and the next fails.
    // This makes the test resilient to pre-existing data on the parent account.
    const countRows = await testDb`
      SELECT count(*)::int AS total FROM wm_memories
      WHERE account_id IN (
        SELECT id FROM wm_accounts
        WHERE id = ${accountIdA} OR parent_account_id = ${accountIdA}
      )
      AND superseded_by IS NULL
    `;
    const currentTotal = countRows[0].total;
    await updateAccount(accountIdA, { memory_limit: currentTotal + 1 });

    // One more write should succeed
    const res2 = await apiCall(
      "POST",
      "/v1/memories",
      {
        scope: "agent-user-1",
        key: "k2",
        value: "v2",
      },
      { key: containerRawKey }
    );
    assert(res2.status === 200, `write at limit-1: expected 200, got ${res2.status}`);

    // Next write should fail (quota exceeded)
    const res3 = await apiCall(
      "POST",
      "/v1/memories",
      {
        scope: "agent-user-1",
        key: "k3",
        value: "v3",
      },
      { key: containerRawKey }
    );
    assert(res3.status === 403, `write at limit: expected 403, got ${res3.status}`);
    assert(
      res3.body.error.code === "quota_exceeded",
      `expected quota_exceeded, got ${res3.body.error.code}`
    );

    // Restore limit
    await updateAccount(accountIdA, { memory_limit: 1000 });
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 9: List containers
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "List containers returns all 10 with memory counts and total",
  fn: async () => {
    const res = await apiCall("GET", "/v1/containers", undefined);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.total === 10, `expected total=10, got ${res.body.total}`);
    assert(
      res.body.containers.length === 10,
      `expected 10 containers, got ${res.body.containers.length}`
    );
    // The first container should have 2 memories from the quota test
    const first = res.body.containers.find((a: any) => a.id === containerId);
    assert(first !== undefined, "container not found in list");
    assert(first.memoryCount === 2, `expected memoryCount=2, got ${first.memoryCount}`);
    assert(first.name === "agent-alpha", `expected name=agent-alpha, got ${first.name}`);
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 10: Get specific container
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Get specific container returns memory and key counts",
  fn: async () => {
    const res = await apiCall("GET", `/v1/containers/${containerId}`, undefined);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.container.id === containerId, "id mismatch");
    assert(
      res.body.container.memoryCount === 2,
      `expected memoryCount=2, got ${res.body.container.memoryCount}`
    );
    assert(
      res.body.container.activeKeyCount === 1,
      `expected activeKeyCount=1, got ${res.body.container.activeKeyCount}`
    );
    assert(
      res.body.container.name === "agent-alpha",
      `expected name, got ${res.body.container.name}`
    );
    assert(res.body.container.metadata.purpose === "testing", "metadata missing");
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 11: Cross-account isolation — account B cannot see account A's subs
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Cross-account isolation: account B cannot GET account A's container (404)",
  fn: async () => {
    // Promote B to pro so it has access to container endpoints
    await updateAccount(accountIdB, { plan_tier: "pro" });

    const res = await apiCall("GET", `/v1/containers/${containerId}`, undefined, {
      key: API_KEY_B,
    });
    assert(res.status === 404, `expected 404, got ${res.status}`);
    assert(res.body.error.code === "not_found", `expected not_found, got ${res.body.error.code}`);
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 12: Cross-account isolation — account B cannot delete account A's sub
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Cross-account isolation: account B cannot DELETE account A's container (404)",
  fn: async () => {
    const res = await apiCall(
      "DELETE",
      `/v1/containers/${containerId}`,
      { confirm: true },
      {
        key: API_KEY_B,
      }
    );
    assert(res.status === 404, `expected 404, got ${res.status}`);
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 13: Cross-account isolation — account B cannot revoke account A's key
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Cross-account isolation: account B cannot revoke account A's container key (404)",
  fn: async () => {
    const res = await apiCall(
      "DELETE",
      `/v1/containers/${containerId}/keys/${containerKeyId}`,
      undefined,
      { key: API_KEY_B }
    );
    assert(res.status === 404, `expected 404, got ${res.status}`);
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 14: Revoke container key
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Revoke container key returns revoked:true, subsequent calls return 401",
  fn: async () => {
    const revokeRes = await apiCall(
      "DELETE",
      `/v1/containers/${containerId}/keys/${containerKeyId}`,
      undefined
    );
    assert(revokeRes.status === 200, `expected 200, got ${revokeRes.status}`);
    assert(
      revokeRes.body.result?.revoked === true,
      `expected result.revoked=true, got ${JSON.stringify(revokeRes.body.result)}`
    );
    assert(
      typeof revokeRes.body.result?.revokedAt === "string",
      `expected result.revokedAt string, got ${typeof revokeRes.body.result?.revokedAt}`
    );

    // Subsequent call with revoked key should fail
    const res = await apiCall("GET", "/v1/health", undefined, { key: containerRawKey });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    assert(
      res.body.error.code === "unauthorized",
      `expected unauthorized, got ${res.body.error.code}`
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 15: Delete container without confirm → validation error
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Delete container without confirm:true returns 400",
  fn: async () => {
    const res = await apiCall("DELETE", `/v1/containers/${containerId}`, { confirm: false });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(
      res.body.error.code === "invalid_request",
      `expected invalid_request, got ${res.body.error.code}`
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 16: Delete container with confirm → cascade
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Delete container with confirm:true cascades to memories and keys",
  fn: async () => {
    const res = await apiCall("DELETE", `/v1/containers/${containerId}`, { confirm: true });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      res.body.result?.deleted === true,
      `expected result.deleted=true, got ${JSON.stringify(res.body.result)}`
    );

    // Container should be gone
    const getRes = await apiCall("GET", `/v1/containers/${containerId}`, undefined);
    assert(getRes.status === 404, `expected 404, got ${getRes.status}`);

    // Memories should be cascaded
    const memRows = await testDb`
      SELECT count(*)::int AS count FROM wm_memories WHERE account_id = ${containerId}
    `;
    assert(memRows[0].count === 0, `expected 0 memories, got ${memRows[0].count}`);
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Test 17: Key expiry
// ════════════════════════════════════════════════════════════════════════════
tests.push({
  name: "Expired key returns 401 key_expired after TTL passes",
  fn: async () => {
    // Create a fresh container for this test
    const createRes = await apiCall("POST", "/v1/containers", { name: "expiry-test" });
    assert(createRes.status === 201, `create: expected 201, got ${createRes.status}`);
    const expirySubId = createRes.body.container.id;

    // Mint a key with 2-second TTL
    const keyRes = await apiCall("POST", `/v1/containers/${expirySubId}/keys`, {
      issuedTo: "short-lived",
      expiresIn: 2,
    });
    assert(keyRes.status === 201, `key: expected 201, got ${keyRes.status}`);
    const shortKey = keyRes.body.rawKey;

    // Should work immediately
    const okRes = await apiCall("GET", "/v1/health", undefined, { key: shortKey });
    assert(okRes.status === 200, `immediate: expected 200, got ${okRes.status}`);

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Should fail with key_expired
    const expiredRes = await apiCall("GET", "/v1/health", undefined, { key: shortKey });
    assert(expiredRes.status === 401, `expired: expected 401, got ${expiredRes.status}`);
    assert(
      expiredRes.body.error.code === "key_expired",
      `expected key_expired, got ${expiredRes.body.error.code}`
    );

    // Clean up
    await apiCall("DELETE", `/v1/containers/${expirySubId}`, { confirm: true });
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Runner
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Containers E2E tests`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Resolve account IDs
  accountIdA = await resolveAccountId(API_KEY!);
  accountIdB = await resolveAccountId(API_KEY_B!);
  console.log(`  Account A: ${accountIdA}`);
  console.log(`  Account B: ${accountIdB}\n`);

  const totalStart = performance.now();
  let passed = 0;
  let failed = 0;

  try {
    for (const test of tests) {
      const start = performance.now();
      try {
        await test.fn();
        const ms = Math.round(performance.now() - start);
        console.log(`  \u2713 ${test.name} (${ms}ms)`);
        passed++;
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        console.log(`  \u2717 ${test.name} (${ms}ms)`);
        console.log(`    ${err instanceof Error ? err.message : err}\n`);
        failed++;
        break;
      }
    }
  } finally {
    // Cleanup: reset accounts to known-good state, delete any leftover containers
    try {
      await testDb`DELETE FROM wm_accounts WHERE parent_account_id = ${accountIdA}`;
      await testDb`DELETE FROM wm_accounts WHERE parent_account_id = ${accountIdB}`;
      await updateAccount(accountIdA, { plan_tier: "free", memory_limit: 1000 });
      await updateAccount(accountIdB, { plan_tier: "free", memory_limit: 1000 });
    } catch (e) {
      console.error("WARNING: cleanup failed:", e);
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
