// Scope enforcement for authenticated routes.
//
// Every API key stores its granted scopes as a comma-separated string
// (e.g. "memory:read,memory:write,account:admin"). Route handlers call
// requireScopes(c, "memory:write") at the top of the handler; if a scope
// is missing, the helper returns a ready-to-return error body and the
// handler hands it off with `return c.json(result, 403)`. Matches the
// inline two-liner pattern used by requireAdminScope in containers.ts
// and requirePlan in plan-enforcement.ts.

type ScopeErrorBody = {
  error: {
    code: "insufficient_scope";
    message: string;
    details: { required: string[]; granted: string[] };
    request_id: string;
  };
};

type ScopeContext = {
  get(key: "apiKey"): { scopes: string };
  get(key: "requestId"): string;
};

function parseGranted(scopes: string): string[] {
  return scopes
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Check the calling key's scopes against a required set. Returns null when
 * every required scope is granted, or a ready-to-return 403 error body when
 * one or more scopes are missing. Usage:
 *
 *   const scopeError = requireScopes(c, "memory:write");
 *   if (scopeError) return c.json(scopeError, 403);
 */
export function requireScopes(c: ScopeContext, ...required: string[]): ScopeErrorBody | null {
  const apiKey = c.get("apiKey");
  const granted = parseGranted(apiKey.scopes);
  const missing = required.filter((r) => !granted.includes(r));
  if (missing.length === 0) return null;

  return {
    error: {
      code: "insufficient_scope",
      message: `API key lacks required scope(s): ${missing.join(", ")}`,
      details: { required: missing, granted },
      request_id: c.get("requestId"),
    },
  };
}
