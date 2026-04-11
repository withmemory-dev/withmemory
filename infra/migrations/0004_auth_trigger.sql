-- Auth-to-wm_users sync trigger.
-- HOSTED ONLY: requires Supabase auth schema (auth.users table).
-- Self-hosted path uses CLI seed for account creation and never touches auth.users.
-- This file is applied manually (not via Drizzle Kit) because Drizzle cannot
-- express cross-schema triggers.
--
-- Behavior: when a row is inserted or updated in auth.users (user signs up via
-- Google OAuth or magic link, or later updates their profile), create or update
-- a corresponding wm_users row. Fires on both INSERT and UPDATE so that
-- email/display_name changes in auth.users (e.g., Google profile name update)
-- propagate to wm_users via the ON CONFLICT DO UPDATE upsert path.
--
-- Runs as SECURITY DEFINER (postgres role) to cross the auth→public schema boundary.
-- Surface area is minimal: single INSERT/UPDATE with hardcoded target table.

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.wm_users (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NULL)
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();
