-- Migration 121: canonicalize uw_role.limit_basis + expose it on v_user_mandate
-- Fully idempotent — safe to run multiple times on any DB state.
--
-- Canonical enum: { EPI, EXPOSURE_100PCT, SIGNED_EXPOSURE }.
-- Default + fallback is SIGNED_EXPOSURE ("the written line must not breach the
-- mandate"). Migration 118 allowed 'PREMIUM' and did NOT expose limit_basis on
-- v_user_mandate, so approvals routing couldn't read it and silently defaulted.
-- This: maps PREMIUM→EPI, replaces the CHECK with the canonical three, keeps the
-- SIGNED_EXPOSURE default, and recreates v_user_mandate to SELECT limit_basis.

-- 1. Drop the old CHECK first (it forbids EPI), then map the legacy value.
ALTER TABLE public.uw_role DROP CONSTRAINT IF EXISTS uw_role_limit_basis_check;

UPDATE public.uw_role SET limit_basis = 'EPI', updated_at = now()
 WHERE limit_basis = 'PREMIUM';

-- Keep SIGNED_EXPOSURE as the column default (idempotent).
ALTER TABLE public.uw_role ALTER COLUMN limit_basis SET DEFAULT 'SIGNED_EXPOSURE';

-- 2. Add the canonical CHECK constraint.
ALTER TABLE public.uw_role
  ADD CONSTRAINT uw_role_limit_basis_check
  CHECK (limit_basis IN ('EPI', 'EXPOSURE_100PCT', 'SIGNED_EXPOSURE'));

-- 3. Recreate v_user_mandate exposing limit_basis (appended column; matches the
--    migration-040 definition otherwise).
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
  r.limit_basis
FROM public.uw_user u
JOIN public.uw_role r ON r.role_id = u.role_id
LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
WHERE u.is_active = true;
