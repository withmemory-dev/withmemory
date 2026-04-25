import Stripe from "stripe";

// Cloudflare Workers don't ship Node's `http`/`https`, so we hand Stripe
// a fetch-based HTTP client. The SDK's pinned `LatestApiVersion` constant
// (currently "2026-04-22.dahlia") is whatever the installed SDK was built
// against — we let TypeScript infer it from the SDK rather than hard-code
// a date that would drift when the SDK is upgraded.
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}
