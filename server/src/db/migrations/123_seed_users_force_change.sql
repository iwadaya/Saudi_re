-- Migration 123: seed three placeholder users with a forced first-login password change.
--
-- Temp password for all three is 'Universe#1234' (meets the >= 8 policy). The
-- scrypt hash below was generated ONCE, out-of-band, with the app's own
-- hashPassword (server/src/routes/auth.js) so no plaintext lands in the repo:
--   node -e "import('./server/src/routes/auth.js').then(m=>console.log(m.hashPassword('Universe#1234')))"
-- verifyPassword re-derives with the embedded salt, so this single literal works
-- for all three rows. must_change_password = true forces the change on first login
-- (hard server-side gate in app.js; mandatory modal on the client).
--
-- Fully idempotent (DO-block / IF NOT EXISTS / NOT EXISTS style) — runs clean twice.

-- 1. The forced-change flag.
ALTER TABLE public.uw_user
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- 2. Expose it on the canonical identity view (append-only recreate of the
--    migration-121 definition — login/authenticate/auth-me all read this view).
CREATE OR REPLACE VIEW public.v_user_mandate AS
SELECT
  u.user_id,
  COALESCE(u.username, split_part(u.email,'@',1)) AS username,
  u.display_name,
  u.email,
  COALESCE(u.office, 'Riyadh') AS office,
  u.is_active,
  COALESCE(u.failed_attempts, 0) AS failed_attempts,
  u.locked_until,
  u.password_hash,
  r.role_id,
  r.role_name,
  r.role_code,
  r.hierarchy_level,
  r.can_override_below,
  r.display_order,
  COALESCE(m.treaty_limit_usd, r.authority_limit_usd) AS effective_limit_usd,
  m.single_risk_limit_usd,
  m.limit_currency,
  m.allowed_cob_ids,
  m.restricted_cob_ids,
  m.allowed_country_ids,
  COALESCE(m.treaty_type_scope, 'BOTH')   AS treaty_type_scope,
  COALESCE(m.approvals_required, 1)        AS approvals_required,
  m.effective_from,
  m.effective_to,
  (m.effective_to IS NULL OR m.effective_to >= current_date) AS mandate_active,
  r.limit_basis,
  u.must_change_password
FROM public.uw_user u
JOIN public.uw_role r ON r.role_id = u.role_id
LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
WHERE u.is_active = true;

-- 3. The UW exclusion set references Political Violence, which was not in the
--    seeded class_of_business catalogue (only Agriculture + Energy were). Add it
--    idempotently so the exclusion is a real, referenceable line of business.
INSERT INTO public.class_of_business (class_of_business)
SELECT 'Political Violence'
WHERE NOT EXISTS (
  SELECT 1 FROM public.class_of_business WHERE class_of_business = 'Political Violence'
);

-- 4. Seed the three placeholder users + a default mandate each (migration 132 turns
--    them into the generic Underwriter 2-4 personas). Idempotent via NOT EXISTS on
--    username (its only unique index is partial — WHERE username IS NOT NULL — so
--    ON CONFLICT (username) can't infer it cleanly; NOT EXISTS is the robust form).
--    Limits are set explicitly on the mandate to the spec's figures (the UW role
--    authority_limit is 10M and CA's is null, so a role-only inherit wouldn't hit
--    25M/100M). UW users are restricted from {Agriculture, Energy, Political
--    Violence}; the Chief Actuary has no exclusions.
DO $$
DECLARE
  v_role_uw uuid;
  v_role_ca uuid;
  v_excl    uuid[];
  v_user    uuid;
  rec       RECORD;
  pw        CONSTANT text := 'scrypt$8dbc8c8afdb43d3d3d14e6c355f84ba2$4125117fdff269d3874c9562a112ddcf89e686626ee49baca0f546a8399e6718f6ae28056e15795abfaab769ec0c5e05170e5d2e5e8072faa9cbde750ba5a71e';
BEGIN
  SELECT role_id INTO v_role_uw FROM public.uw_role WHERE role_code = 'UW' LIMIT 1;
  SELECT role_id INTO v_role_ca FROM public.uw_role WHERE role_code = 'CA' LIMIT 1;
  SELECT COALESCE(array_agg(class_of_business_id), ARRAY[]::uuid[]) INTO v_excl
    FROM public.class_of_business
   WHERE class_of_business IN ('Agriculture', 'Energy', 'Political Violence');

  FOR rec IN
    SELECT * FROM (VALUES
      ('seed.underwriter2',   'seed.underwriter2@universe3.app',   'Seeded Underwriter 2',  v_role_uw,  25000000::numeric, v_excl),
      ('seed.underwriter3',   'seed.underwriter3@universe3.app',   'Seeded Underwriter 3',  v_role_uw,  25000000::numeric, v_excl),
      ('seed.chief.actuary',  'seed.chief.actuary@universe3.app',  'Seeded Chief Actuary',  v_role_ca, 100000000::numeric, ARRAY[]::uuid[])
    ) AS t(username, email, display_name, role_id, treaty_limit, restricted)
  LOOP
    IF rec.role_id IS NULL THEN
      RAISE NOTICE 'seed_users_force_change: skipping % — role not found', rec.username;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.uw_user WHERE username = rec.username) THEN
      CONTINUE; -- already seeded
    END IF;

    INSERT INTO public.uw_user
      (username, email, display_name, role_id, office, password_hash, must_change_password, is_active)
    VALUES
      (rec.username, rec.email, rec.display_name, rec.role_id, 'Riyadh', pw, true, true)
    RETURNING user_id INTO v_user;

    INSERT INTO public.user_mandate
      (user_id, treaty_limit_usd, restricted_cob_ids, treaty_type_scope, approvals_required)
    VALUES
      (v_user, rec.treaty_limit, rec.restricted, 'BOTH', 1)
    ON CONFLICT (user_id) DO NOTHING;
  END LOOP;
END $$;
