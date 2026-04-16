import type { Context } from "hono";

/**
 * Extract the client IP address from the request.
 *
 * Order of precedence:
 * 1. CF-Connecting-IP (Cloudflare Workers)
 * 2. X-Forwarded-For (first IP in comma-separated list)
 * 3. X-Real-IP
 * 4. Fallback: "unknown"
 *
 * Trust model: this prioritization is safe for the Cloudflare Workers
 * deployment because CF-Connecting-IP is set by Cloudflare's edge and
 * cannot be spoofed by the caller — any inbound value is overwritten.
 * If this code is ever reused in a non-Cloudflare deployment (e.g., a
 * self-hosted Node build behind a different proxy), CF-Connecting-IP
 * becomes attacker-controllable and must be removed from the priority
 * order or validated against a known proxy.
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
