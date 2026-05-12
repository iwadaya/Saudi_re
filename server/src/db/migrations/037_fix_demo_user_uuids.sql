-- Migration 037: Set up exactly two demo users: CUO and Underwriter
-- Cleans up all old demo users regardless of email state.

-- Remove all old demo users (including .old. suffixed emails from prior migrations)
DELETE FROM public.uw_user WHERE email LIKE '%universe3.app%';

-- Insert the two clean demo users
INSERT INTO public.uw_user (user_id, email, username, display_name, role_id, office, password_hash, is_active)
SELECT u.user_id::uuid, u.email, u.username, u.display_name, r.role_id, 'Riyadh', 'DEMO_HASH_2026', true
FROM (VALUES
  ('00000000-0000-0000-0000-000000000001', 'cuo@universe3.app', 'cuo',         'Chief Underwriter', 'CU'),
  ('00000000-0000-0000-0000-000000000002', 'uw@universe3.app',  'underwriter', 'Underwriter',       'TUW')
) AS u(user_id, email, username, display_name, role_code)
JOIN public.uw_role r ON r.role_code = u.role_code
WHERE r.role_id IS NOT NULL
ON CONFLICT (email) DO UPDATE SET
  user_id      = EXCLUDED.user_id,
  username     = EXCLUDED.username,
  display_name = EXCLUDED.display_name,
  role_id      = EXCLUDED.role_id,
  updated_at   = now();