-- Migration 120: retire the DEMO_HASH_2026 password sentinel
-- Fully idempotent — safe to run multiple times on any DB state.
--
-- Before this, every seeded user carried password_hash='DEMO_HASH_2026' and the
-- column DEFAULTed to it, and login accepted the universal 'demo2026' password.
-- That demo shortcut is now gated behind ALLOW_DEMO_AUTH (dev/test only), so in
-- production the stored hash is the only credential. We therefore:
--   1. Replace the sentinel with a REAL scrypt-format hash whose plaintext is a
--      random 32-byte secret nobody holds — i.e. the seeded demo accounts are
--      locked out of password login in production until an admin resets them.
--      (Dev/test still log in via the ALLOW_DEMO_AUTH shortcut, which ignores
--      the stored hash.) This is preferred over deactivating them so they still
--      appear in v_user_mandate for token auth once a real password is set.
--   2. Drop the insecure column DEFAULT so new rows must supply a real hash.

UPDATE public.uw_user
   SET password_hash = 'scrypt$babd9ce3148bdab4a9f38627b907dc0d$2c34deda8f32bd675d511b5f17e0eee0e06f6ecd927885d4d10668591154840596be1bb1102fdb1cfb60f594740494633f0673dc8df0b031d9f36c823c3cce96',
       updated_at = now()
 WHERE password_hash = 'DEMO_HASH_2026' OR password_hash IS NULL;

-- Drop the DEMO_HASH_2026 default (no-op if already dropped).
ALTER TABLE public.uw_user ALTER COLUMN password_hash DROP DEFAULT;

-- Keep the column NOT NULL (it already is from migration 034); the backfill
-- above guarantees no NULLs remain.
ALTER TABLE public.uw_user ALTER COLUMN password_hash SET NOT NULL;
