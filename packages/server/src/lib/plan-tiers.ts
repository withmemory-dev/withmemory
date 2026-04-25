import type { PlanTier } from "../db/schema";

// Memory + container limits per plan tier. The integer columns on
// wm_accounts (memoryLimit, monthlyApiCallLimit) can't hold Infinity, so
// enterprise/team get a sentinel "very large" value when written to the
// row — the runtime treats them as effectively unlimited via the
// container limit map below. monthlyApiCallLimit is reserved for future
// enforcement (the column exists, no middleware increments it yet).
export const PLAN_LIMITS: Record<
  PlanTier,
  { memoryLimit: number; monthlyApiCallLimit: number; containerLimit: number | null }
> = {
  free: { memoryLimit: 1000, monthlyApiCallLimit: 10000, containerLimit: 0 },
  basic: { memoryLimit: 10000, monthlyApiCallLimit: 100000, containerLimit: 0 },
  pro: { memoryLimit: 100000, monthlyApiCallLimit: 1000000, containerLimit: 10 },
  team: { memoryLimit: 500000, monthlyApiCallLimit: 5000000, containerLimit: 100 },
  // null = unlimited, surfaced to clients as the integer column's stored value
  enterprise: { memoryLimit: 100000000, monthlyApiCallLimit: 100000000, containerLimit: null },
};

export type PaidTier = "basic" | "pro";

export function priceIdToTier(
  priceId: string,
  env: { STRIPE_PRICE_BASIC?: string; STRIPE_PRICE_PRO?: string }
): PaidTier | null {
  if (env.STRIPE_PRICE_BASIC && priceId === env.STRIPE_PRICE_BASIC) return "basic";
  if (env.STRIPE_PRICE_PRO && priceId === env.STRIPE_PRICE_PRO) return "pro";
  return null;
}

export function tierToPriceId(
  tier: PaidTier,
  env: { STRIPE_PRICE_BASIC?: string; STRIPE_PRICE_PRO?: string }
): string | null {
  if (tier === "basic") return env.STRIPE_PRICE_BASIC ?? null;
  if (tier === "pro") return env.STRIPE_PRICE_PRO ?? null;
  return null;
}
