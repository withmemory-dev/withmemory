import type { Context } from "hono";

/** Shared scope max length — matches varchar(255) convention */
export const SCOPE_MAX_LENGTH = 255;

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
          request_id: c.get("requestId"),
        },
      },
      400
    );
  }
}
