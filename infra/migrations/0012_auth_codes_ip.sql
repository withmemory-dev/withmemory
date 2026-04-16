-- Unit 16: per-IP rate limit on /auth/request-code. Adds ip_address column
-- to wm_auth_codes plus an index on (ip_address, created_at) so the route
-- can count recent code requests per source IP without a table scan.

ALTER TABLE wm_auth_codes
  ADD COLUMN IF NOT EXISTS ip_address text;

CREATE INDEX IF NOT EXISTS wm_auth_codes_ip_created_idx
  ON wm_auth_codes (ip_address, created_at);
