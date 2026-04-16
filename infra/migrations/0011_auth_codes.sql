-- Unit 07: Email verification codes for agent-initiated signup.

CREATE TABLE IF NOT EXISTS wm_auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  used_at timestamptz
);

-- Rate limit queries: find codes sent to an email in the last hour
CREATE INDEX IF NOT EXISTS wm_auth_codes_email_created_idx
  ON wm_auth_codes (email, created_at);
