-- 127_auth_sessions.sql — P1-identity Phase 0a: server-side sessions + revocation.
--
-- Adds the revocation keystone the stateless-token design lacked:
--   • auth_session — one row per login (the token now carries its session_id as
--     `sid`); a request is valid only while its session row is live.
--   • uw_user.session_epoch — a per-user counter; bumping it mass-revokes every
--     token for that user in O(1) (used on password/role change + deactivation in
--     Phase 0b). The token carries the epoch it was minted under.
--   • uw_user.auth_provider / idp_subject — SSO link columns (inert until Phase 1).
--
-- Revocation levers (belt-and-suspenders):
--   per-device logout → DELETE/revoke one auth_session row;
--   revoke-all        → bump session_epoch (+ revoke live rows).

CREATE TABLE IF NOT EXISTS public.auth_session (
  session_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.uw_user(user_id) ON DELETE CASCADE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz,
  revoked_at     timestamptz,                 -- NULL = live
  revoked_reason text,                         -- LOGOUT | PASSWORD_CHANGE | ROLE_CHANGE | DEACTIVATED | ADMIN | SUPERSEDED
  auth_method    text NOT NULL DEFAULT 'PASSWORD',  -- PASSWORD | SSO_OIDC | SSO_SAML | BREAK_GLASS
  amr            text[],                        -- IdP auth methods (SSO; e.g. {pwd,mfa})
  idp_sub        text,                          -- IdP subject (SSO back-channel logout match)
  idp_sid        text,                          -- IdP session id (SSO back-channel logout)
  ip             inet,
  user_agent     text
);

-- Live-session lookups per user (logout-all, session inventory).
CREATE INDEX IF NOT EXISTS idx_auth_session_user_live
  ON public.auth_session (user_id) WHERE revoked_at IS NULL;
-- Back-channel logout by IdP session id (Phase 1).
CREATE INDEX IF NOT EXISTS idx_auth_session_idp_sid
  ON public.auth_session (idp_sid) WHERE idp_sid IS NOT NULL;

-- Per-user revocation epoch + SSO link columns.
ALTER TABLE public.uw_user
  ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auth_provider text   NOT NULL DEFAULT 'LOCAL',  -- LOCAL | SSO
  ADD COLUMN IF NOT EXISTS idp_subject   text;

-- One external IdP subject maps to at most one user (SSO link uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS uq_uw_user_idp_subject
  ON public.uw_user (idp_subject) WHERE idp_subject IS NOT NULL;

-- Expose session_epoch + auth_provider on the per-request identity view so the
-- authenticate() middleware can validate the token epoch in its single query.
-- (CREATE OR REPLACE appends the two new columns at the end of the existing view.)
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
  u.must_change_password,
  u.session_epoch,
  u.auth_provider
FROM public.uw_user u
JOIN public.uw_role r ON r.role_id = u.role_id
LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
WHERE u.is_active = true;
