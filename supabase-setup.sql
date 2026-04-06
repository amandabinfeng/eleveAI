-- ═══════════════════════════════════════════════════════════════════════════
-- Élevé AI — Supabase Setup
-- Run this entire script in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Profiles table ───────────────────────────────────────────────────────
-- Auto-populated by trigger on every new sign-up.

CREATE TABLE IF NOT EXISTS profiles (
  id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email      TEXT,
  role       TEXT        NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can view their own profile
CREATE POLICY "users_read_own_profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- Admins can view ALL profiles (used by admin panel)
CREATE POLICY "admins_read_all_profiles"
  ON profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );


-- ── 2. Auto-create profile on sign-up ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ── 3. Analyses table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analyses (
  id          BIGINT      PRIMARY KEY,          -- Date.now() from client
  user_id     UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type        TEXT        NOT NULL CHECK (type IN ('solo', 'progress')),
  pose        TEXT,
  score       INT,
  style       TEXT,
  age_group   TEXT,
  date        TEXT,
  report      JSONB,                            -- solo analysis result
  prog_result JSONB,                            -- progress comparison result
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

-- Users can SELECT / INSERT / UPDATE / DELETE their own rows
CREATE POLICY "users_manage_own_analyses"
  ON analyses FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Admins can SELECT all rows (cross-user view for admin panel)
CREATE POLICY "admins_read_all_analyses"
  ON analyses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );


-- ── 4. App settings table (global config editable by admin) ────────────────
-- Stores key-value pairs like default_quota. Server reads this at runtime.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the default quota (5 free analyses per user)
INSERT INTO settings (key, value) VALUES ('default_quota', '5')
  ON CONFLICT (key) DO NOTHING;

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Service role (used by server.js) bypasses RLS automatically.
-- Admins can read settings via browser client if needed.
CREATE POLICY "admins_read_settings"
  ON settings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );


-- ── 5. Per-user monthly quota ───────────────────────────────────────────────
-- Adds an optional per-user quota override column to profiles.
-- NULL = use server default (DEFAULT_MONTHLY_QUOTA in server.js, currently 10).
-- Run this once if you already have the profiles table from the script above.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS monthly_quota INT DEFAULT NULL;

-- Tracks when the last quota-exceeded notification was sent for this user.
-- Prevents duplicate admin emails when the user retries repeatedly.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS quota_notified_at TIMESTAMPTZ DEFAULT NULL;

-- Admins can UPDATE profiles (needed for set-quota endpoints)
CREATE POLICY "admins_update_profiles"
  ON profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- Also allow the service role to update any profile (used by server-side admin endpoints)
-- This is handled automatically by the service role key bypassing RLS.


-- ── 5. Grant yourself admin role ────────────────────────────────────────────
-- After running this script and signing in for the first time, run:
--
--   UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';
--
-- That's all — the admin panel will appear automatically in the sidebar.
