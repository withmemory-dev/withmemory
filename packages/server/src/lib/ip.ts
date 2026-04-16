import type { Context } from "hono";

/**
 * Extract the client IP address from the request.
 *
 * Order of precedence:
 * 1. CF-Connecting-IP (Cloudflare Workers)
 * 2. X-Forwarded-For (first IP in comma-separated list)
 * 3. X-Real-IP
 * 4. Fallback: "unknown"
 */
export function getClientIp(c: Context): string {
  const cfIp = c.req.header("CF-Connecting-IP");
  if (cfIp) return cfIp;

  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();

  const realIp = c.req.header("X-Real-IP");
  if (realIp) return realIp;

  return "unknown";
}
