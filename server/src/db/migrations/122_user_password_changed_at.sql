-- Migration 122: track when a user last changed their own password.
-- Set by the self-service POST /api/auth/change-password route. Nullable: a
-- NULL means "never self-changed" (seeded/admin-set hash). Idempotent.

ALTER TABLE public.uw_user
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
