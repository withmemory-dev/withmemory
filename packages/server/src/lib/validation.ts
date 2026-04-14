import type { Context } from "hono";

/** Shared scope max length — matches varchar(255) convention */
export const SCOPE_MAX_LENGTH = 255;
/** @deprecated Use SCOPE_MAX_LENGTH */
export const USER_ID_MAX_LENGTH = SCOPE_MAX_LENGTH;

// ─── Parameter normalization (old → new names) ───────────────────────────────
// Accepts both old and new parameter names for one release cycle.
// Old names emit an X-Deprecation-Warning header.

type DeprecationMap = Record<string, string>;

const PARAM_RENAMES: DeprecationMap = {
  userId: "forScope",
  key: "forKey",
  input: "query", // recall only — commit still uses input/output
};

/**
 * Normalize deprecated parameter names in a request body.
 * Returns the normalized body and an array of deprecation warnings.
 * Only renames keys listed in `fields` (to avoid renaming `key` in contexts
 * where it's not a memory key, e.g. API key objects).
 */
export function normalizeParams(
  body: Record<string, unknown>,
  fields: string[]
): { normalized: Record<string, unknown>; warnings: string[] } {
  const normalized = { ...body };
  const warnings: string[] = [];

  for (const oldName of fields) {
    const newName = PARAM_RENAMES[oldName];
    if (!newName) continue;
    if (oldName in normalized && !(newName in normalized)) {
      normalized[newName] = normalized[oldName];
      delete normalized[oldName];
      warnings.push(`Parameter "${oldName}" is deprecated. Use "${newName}" instead.`);
    }
  }

  return { normalized, warnings };
}

/**
 * Set deprecation warning header on a Hono context if there are warnings.
 */
export function setDeprecationHeader(c: Context, warnings: string[]): void {
  if (warnings.length > 0) {
    c.header("X-Deprecation-Warning", warnings.join("; "));
  }
}

/**
 * Shared Zod validation error hook for zValidator.
 * Returns a 400 JSON envelope on validation failure.
 */
export function zodErrorHook(
  result: { success: boolean; error?: { issues: unknown[] } },
  c: Context
) {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: "invalid_request",
          message: "Invalid request body",
          details: result.error!.issues,
        },
      },
      400
    );
  }
}
