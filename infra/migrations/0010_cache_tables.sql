-- Unit 06: Ephemeral zero-auth cache tables for bootstrap demo flow.

CREATE TABLE IF NOT EXISTS wm_caches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  ip_address text NOT NULL,
  ttl_seconds integer NOT NULL DEFAULT 86400,
  expires_at timestamptz NOT NULL,
  claim_token_hash text NOT NULL UNIQUE,
  claimed_by_account_id uuid REFERENCES wm_accounts(id),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wm_cache_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_id uuid NOT NULL REFERENCES wm_caches(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cache_id, key)
);

-- Rate limit queries: find caches created by an IP in the last 24h
CREATE INDEX IF NOT EXISTS wm_caches_ip_created_idx
  ON wm_caches (ip_address, created_at);

-- Future cleanup cron: find expired caches
CREATE INDEX IF NOT EXISTS wm_caches_expires_at_idx
  ON wm_caches (expires_at);
