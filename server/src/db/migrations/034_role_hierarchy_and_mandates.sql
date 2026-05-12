-- Migration 034: Role hierarchy, mandate system, user management
-- Fully idempotent — safe to run multiple times on any DB state.
-- All changes use IF NOT EXISTS or DO block column-existence checks.

-- ─── Ensure base tables exist (in case 001_foundation hasn't run) ───────────
CREATE TABLE IF NOT EXISTS public.uw_role (
  role_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name           text NOT NULL UNIQUE,
  authority_limit_usd numeric(18,2),
  display_order       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.uw_user (
  user_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role_id      uuid NOT NULL REFERENCES public.uw_role(role_id),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ─── Add new columns to uw_role (each in its own DO block) ──────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_role' AND column_name='hierarchy_level') THEN
    ALTER TABLE public.uw_role ADD COLUMN hierarchy_level integer NOT NULL DEFAULT 10;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_role' AND column_name='can_override_below') THEN
    ALTER TABLE public.uw_role ADD COLUMN can_override_below boolean NOT NULL DEFAULT true;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_role' AND column_name='role_code') THEN
    ALTER TABLE public.uw_role ADD COLUMN role_code text;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_role_code ON public.uw_role (role_code) WHERE role_code IS NOT NULL;

-- ─── Add new columns to uw_user ─────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='username') THEN
    ALTER TABLE public.uw_user ADD COLUMN username text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='password_hash') THEN
    ALTER TABLE public.uw_user ADD COLUMN password_hash text NOT NULL DEFAULT 'DEMO_HASH_2026';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='office') THEN
    ALTER TABLE public.uw_user ADD COLUMN office text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='is_system_admin') THEN
    ALTER TABLE public.uw_user ADD COLUMN is_system_admin boolean NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='last_login_at') THEN
    ALTER TABLE public.uw_user ADD COLUMN last_login_at timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='failed_attempts') THEN
    ALTER TABLE public.uw_user ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_user' AND column_name='locked_until') THEN
    ALTER TABLE public.uw_user ADD COLUMN locked_until timestamptz;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_user_username ON public.uw_user (username) WHERE username IS NOT NULL;

-- ─── Seed the 5 roles ────────────────────────────────────────────────────────
INSERT INTO public.uw_role (role_name, role_code, authority_limit_usd, hierarchy_level, can_override_below, display_order)
VALUES
  ('Chief Executive',    'CE',  NULL,       1, true, 10),
  ('Chief Underwriter',  'CU',  NULL,       2, true, 20),
  ('Treaty Director',    'TD',  50000000,   3, true, 30),
  ('Treaty Manager',     'TM',  25000000,   4, true, 40),
  ('Treaty Underwriter', 'TUW', 10000000,   5, false,50)
ON CONFLICT (role_name) DO UPDATE SET
  role_code          = EXCLUDED.role_code,
  authority_limit_usd = EXCLUDED.authority_limit_usd,
  hierarchy_level    = EXCLUDED.hierarchy_level,
  can_override_below = EXCLUDED.can_override_below,
  display_order      = EXCLUDED.display_order,
  updated_at         = now();

-- ─── Seed demo users ─────────────────────────────────────────────────────────
INSERT INTO public.uw_user (user_id, email, username, display_name, role_id, office, password_hash, is_active)
SELECT u.user_id::uuid, u.email, u.username, u.display_name, r.role_id, u.office, 'DEMO_HASH_2026', true
FROM (VALUES
  ('00000000-0000-0000-0000-000000000001', 'cuo@universe3.app', 'cuo',          'Chief Underwriting Officer', 'CU',  'Riyadh'),
  ('00000000-0000-0000-0000-000000000002', 'uw@universe3.app',  'underwriter',  'Treaty Underwriter',         'TUW', 'Riyadh')
) AS u(user_id, email, username, display_name, role_code, office)
JOIN public.uw_role r ON r.role_code = u.role_code
ON CONFLICT (email) DO UPDATE SET
  user_id      = EXCLUDED.user_id,
  username     = EXCLUDED.username,
  display_name = EXCLUDED.display_name,
  role_id      = EXCLUDED.role_id,
  office       = EXCLUDED.office,
  updated_at   = now();

-- ─── user_mandate table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_mandate (
  mandate_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.uw_user(user_id) ON DELETE CASCADE,
  treaty_limit_usd      numeric(18,2),
  single_risk_limit_usd numeric(18,2),
  limit_currency        text NOT NULL DEFAULT 'USD',
  allowed_cob_ids       uuid[] NOT NULL DEFAULT '{}',
  restricted_cob_ids    uuid[] NOT NULL DEFAULT '{}',
  allowed_country_ids   uuid[] NOT NULL DEFAULT '{}',
  treaty_type_scope     text NOT NULL DEFAULT 'BOTH'
    CHECK (treaty_type_scope IN ('PROP_ONLY','NP_ONLY','BOTH')),
  approvals_required    integer NOT NULL DEFAULT 1,
  effective_from        date NOT NULL DEFAULT current_date,
  effective_to          date,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- ─── Seed user mandates ──────────────────────────────────────────────────────
INSERT INTO public.user_mandate (user_id, treaty_limit_usd, single_risk_limit_usd, treaty_type_scope, approvals_required)
SELECT u.user_id, m.treaty_limit_usd, m.single_risk_limit_usd, m.treaty_type_scope, m.approvals_required
FROM (VALUES
  ('ce@universe3.app',  NULL::numeric,  NULL::numeric,  'BOTH',      1),
  ('cu@universe3.app',  NULL,           NULL,           'BOTH',      1),
  ('td@universe3.app',  50000000,       10000000,       'BOTH',      1),
  ('tm@universe3.app',  25000000,       5000000,        'BOTH',      2),
  ('tuw@universe3.app', 10000000,       2000000,        'PROP_ONLY', 2)
) AS m(email, treaty_limit_usd, single_risk_limit_usd, treaty_type_scope, approvals_required)
JOIN public.uw_user u ON u.email = m.email
ON CONFLICT (user_id) DO UPDATE SET
  treaty_limit_usd      = EXCLUDED.treaty_limit_usd,
  single_risk_limit_usd = EXCLUDED.single_risk_limit_usd,
  treaty_type_scope     = EXCLUDED.treaty_type_scope,
  approvals_required    = EXCLUDED.approvals_required,
  updated_at            = now();

-- ─── cob_authority_requirement table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cob_authority_requirement (
  cob_auth_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_of_business_id uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  min_hierarchy_level  integer NOT NULL DEFAULT 3,
  requires_dual_approval boolean NOT NULL DEFAULT false,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_of_business_id)
);

-- ─── Extend approval_request ─────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='approval_request' AND column_name='approvals_required') THEN
    ALTER TABLE public.approval_request ADD COLUMN approvals_required integer NOT NULL DEFAULT 1;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='approval_request' AND column_name='approvals_received') THEN
    ALTER TABLE public.approval_request ADD COLUMN approvals_received integer NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ─── v_user_mandate view ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_user_mandate AS
SELECT
  u.user_id,
  u.username,
  u.display_name,
  u.email,
  u.office,
  u.is_active,
  u.failed_attempts,
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
  COALESCE(m.treaty_type_scope, 'BOTH')    AS treaty_type_scope,
  COALESCE(m.approvals_required, 1)         AS approvals_required,
  m.effective_from,
  m.effective_to,
  (m.effective_to IS NULL OR m.effective_to >= current_date) AS mandate_active
FROM public.uw_user u
JOIN public.uw_role r ON r.role_id = u.role_id
LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
WHERE u.is_active = true;

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_uw_user_role   ON public.uw_user (role_id);
CREATE INDEX IF NOT EXISTS idx_uw_user_active ON public.uw_user (is_active, role_id);
CREATE INDEX IF NOT EXISTS idx_user_mandate   ON public.user_mandate (user_id);