-- Per-account API call metering. Increments fire-and-forget from auth
-- middleware; auth middleware also rejects new requests with 429 when the
-- per-period count is at or above monthly_api_call_limit. The counter
-- resets when current_period_start is older than 30 days.
--
-- For sub-accounts, the counter lives on the parent account row — every
-- request through a sub-account key bumps the parent's counter (mirrors
-- the parent-rooted memory quota model).

ALTER TABLE wm_accounts
  ADD COLUMN IF NOT EXISTS api_calls_this_period integer NOT NULL DEFAULT 0;

ALTER TABLE wm_accounts
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz NOT NULL DEFAULT now();
