-- Migration 132: Saudi Re pilot — generic demo personas.
--
-- The seeded demo/test users were the cuo/underwriter pair plus the three
-- placeholder logins from migration 123. For the Saudi Re pilot the login list
-- should show generic personas instead:
--
--   cuo                → Chief Underwriter (CU role — approvals authority)
--   underwriter        → Underwriter 1
--   seed.underwriter2  → Underwriter 2
--   seed.underwriter3  → Underwriter 3
--   seed.chief.actuary → Underwriter 4   (Underwriter role; was Chief Actuary)
--
-- Only those usernames are matched. Any other account — including personal
-- logins an earlier seed created under other names — is left untouched; retire
-- such accounts with server/scripts/manage-user.js.
--
-- Every persona gets a REAL scrypt hash of 'demo2026' so the password works in
-- production where ALLOW_DEMO_AUTH is off (the demo2026 shortcut is dev-only;
-- a stored hash is the production-legitimate path). The hash below was minted
-- once, out-of-band, with the app's own hashPassword (lib/passwordHash.js):
--   node -e "import('./src/lib/passwordHash.js').then(async m => console.log(await m.hashPassword('demo2026')))"
-- must_change_password is cleared (personas are shared demo accounts — the
-- forced-change modal would dead-end the second tester) and locks are reset.
--
-- Ishe Wadaya (the passwordless name-login pilot account) is NOT touched.
--
-- Idempotent: each rename is keyed on the OLD username and guarded against the
-- NEW username already existing, so a second run is a clean no-op.

DO $$
DECLARE
  pw CONSTANT text := 'scrypt$15$8$1$eff2fdc2db41c974beacfe9ef7438095$ffb1f7448e77c8d6784c4c118c85482c16e8729d6f385102cc84413a16a5706d722155d803e808e574407e12d894951544807385eb36c7d1f52d8a83ca3f50b7';
  v_role_uw uuid;
  v_role_cu uuid;
  rec RECORD;
BEGIN
  SELECT role_id INTO v_role_uw FROM public.uw_role WHERE role_code = 'UW' LIMIT 1;
  SELECT role_id INTO v_role_cu FROM public.uw_role WHERE role_code = 'CU' LIMIT 1;

  -- Chief Underwriter — the approvals persona.
  IF NOT EXISTS (SELECT 1 FROM public.uw_user WHERE username = 'chief.underwriter') THEN
    UPDATE public.uw_user SET
      username             = 'chief.underwriter',
      display_name         = 'Chief Underwriter',
      email                = 'chief.underwriter@universe3.app',
      role_id              = COALESCE(v_role_cu, role_id),
      password_hash        = pw,
      must_change_password = false,
      failed_attempts      = 0,
      locked_until         = NULL,
      is_active            = true,
      updated_at           = now()
    WHERE username = 'cuo';
  END IF;

  -- Underwriter 1..4 — generic underwriting personas.
  FOR rec IN
    SELECT * FROM (VALUES
      ('underwriter',        'underwriter1', 'Underwriter 1'),
      ('seed.underwriter2',  'underwriter2', 'Underwriter 2'),
      ('seed.underwriter3',  'underwriter3', 'Underwriter 3'),
      ('seed.chief.actuary', 'underwriter4', 'Underwriter 4')
    ) AS t(old_username, new_username, new_display)
  LOOP
    IF EXISTS (SELECT 1 FROM public.uw_user WHERE username = rec.new_username) THEN
      CONTINUE; -- already renamed
    END IF;
    UPDATE public.uw_user SET
      username             = rec.new_username,
      display_name         = rec.new_display,
      email                = rec.new_username || '@universe3.app',
      role_id              = COALESCE(v_role_uw, role_id),
      password_hash        = pw,
      must_change_password = false,
      failed_attempts      = 0,
      locked_until         = NULL,
      is_active            = true,
      updated_at           = now()
    WHERE username = rec.old_username;
  END LOOP;

  -- Uniform 25M treaty limit for the underwriter personas (Underwriter 4 was
  -- the Chief Actuary and carried 100M — out of place for a UW-role persona).
  UPDATE public.user_mandate m SET
    treaty_limit_usd = 25000000,
    updated_at       = now()
  FROM public.uw_user u
  WHERE u.user_id = m.user_id
    AND u.username IN ('underwriter1', 'underwriter2', 'underwriter3', 'underwriter4')
    AND m.treaty_limit_usd IS DISTINCT FROM 25000000;

  -- The original 'underwriter' seed never got a mandate row — backfill so all
  -- four personas carry the same explicit 25M limit.
  INSERT INTO public.user_mandate (user_id, treaty_limit_usd, treaty_type_scope, approvals_required)
  SELECT u.user_id, 25000000, 'BOTH', 1
  FROM public.uw_user u
  WHERE u.username IN ('underwriter1', 'underwriter2', 'underwriter3', 'underwriter4')
    AND NOT EXISTS (SELECT 1 FROM public.user_mandate m WHERE m.user_id = u.user_id);
END $$;
