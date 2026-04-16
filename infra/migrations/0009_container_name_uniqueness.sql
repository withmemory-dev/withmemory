-- Unit 12: Enforce container name uniqueness per parent account.
-- This is a partial unique index — only applies to rows where parent_account_id IS NOT NULL
-- (i.e., containers, not top-level accounts). Top-level accounts can share names freely.
CREATE UNIQUE INDEX IF NOT EXISTS wm_accounts_parent_name_unique
  ON wm_accounts (parent_account_id, name)
  WHERE parent_account_id IS NOT NULL;
