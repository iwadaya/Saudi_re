-- Migration 118: Title mandate limit basis + approval routing
-- Fully idempotent — safe to run multiple times on any DB state.
--
-- Introduces the six-title mandate/routing model:
--   AN  Analyst
--   UW  Underwriter
--   UM  Underwriting Manager
--   CU  Chief Underwriter
--   CA  Chief Actuary
--   CE  Chief Executive
--
-- Two pieces:
--   1. uw_role.limit_basis — the mandate limit caps written-line
--      SIGNED_EXPOSURE, not premium. Seeded SIGNED_EXPOSURE for all six titles.
--   2. approval_route — one row per (originator_role_code, leg) describing who
--      the item routes to next. The Analyst always goes to the Underwriter
--      first (AN leg1 {UW}); once the Underwriter owns the item it re-routes
--      using the Underwriter's own route (UW leg1 {CU}), so there is no AN
--      leg2 — that keeps a single source of truth for "where does the UW send
--      it" instead of duplicating {CU} onto every junior originator.
--
-- DDL/role-attribute choices (role names, hierarchy_level, the approval_route
-- table shape, and min_approvals for legs the spec left implicit) are set here
-- to sensible defaults; the spec only pinned limit_basis and the approver sets.

-- ─── uw_role.limit_basis ─────────────────────────────────────────────────────
-- uw_role itself is created in migration 034; guard in case this runs first.
CREATE TABLE IF NOT EXISTS public.uw_role (
  role_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_name           text NOT NULL UNIQUE,
  authority_limit_usd numeric(18,2),
  display_order       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_role' AND column_name='role_code') THEN
    ALTER TABLE public.uw_role ADD COLUMN role_code text;
  END IF;
END $$;

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

-- New column: the basis on which the mandate limit is measured. Default
-- SIGNED_EXPOSURE so every existing row (and any future insert) is backfilled
-- to the exposure basis rather than premium.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='uw_role' AND column_name='limit_basis') THEN
    ALTER TABLE public.uw_role ADD COLUMN limit_basis text NOT NULL DEFAULT 'SIGNED_EXPOSURE';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='uw_role' AND constraint_name='uw_role_limit_basis_check') THEN
    ALTER TABLE public.uw_role
      ADD CONSTRAINT uw_role_limit_basis_check CHECK (limit_basis IN ('SIGNED_EXPOSURE','PREMIUM'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_role_code ON public.uw_role (role_code) WHERE role_code IS NOT NULL;

-- ─── Seed the six titles with limit_basis = SIGNED_EXPOSURE ──────────────────
INSERT INTO public.uw_role (role_name, role_code, hierarchy_level, can_override_below, display_order, limit_basis)
VALUES
  ('Chief Executive',        'CE', 1, true,  10, 'SIGNED_EXPOSURE'),
  ('Chief Underwriter',      'CU', 2, true,  20, 'SIGNED_EXPOSURE'),
  ('Chief Actuary',          'CA', 2, true,  25, 'SIGNED_EXPOSURE'),
  ('Underwriting Manager',   'UM', 3, true,  30, 'SIGNED_EXPOSURE'),
  ('Underwriter',            'UW', 4, true,  40, 'SIGNED_EXPOSURE'),
  ('Analyst',                'AN', 5, false, 50, 'SIGNED_EXPOSURE')
ON CONFLICT (role_name) DO UPDATE SET
  role_code          = EXCLUDED.role_code,
  hierarchy_level    = EXCLUDED.hierarchy_level,
  can_override_below = EXCLUDED.can_override_below,
  display_order      = EXCLUDED.display_order,
  limit_basis        = EXCLUDED.limit_basis,
  updated_at         = now();

-- ─── approval_route ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_route (
  route_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  originator_role_code text NOT NULL,
  leg                  integer NOT NULL,
  approver_role_codes  text[] NOT NULL DEFAULT '{}',
  min_approvals        integer NOT NULL DEFAULT 1,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (originator_role_code, leg)
);

-- Remove the legacy Analyst second leg ({CU}) if a prior run seeded it. The
-- Analyst now routes only to the Underwriter; onward routing is the UW's.
DELETE FROM public.approval_route WHERE originator_role_code = 'AN' AND leg = 2;

-- ─── Seed the routes (one leg each) ──────────────────────────────────────────
INSERT INTO public.approval_route (originator_role_code, leg, approver_role_codes, min_approvals, note)
VALUES
  ('AN', 1, ARRAY['UW']::text[],      1, 'Analyst always to Underwriter first'),
  ('UW', 1, ARRAY['CU']::text[],      1, NULL),
  ('UM', 1, ARRAY['CU']::text[],      1, NULL),
  ('CU', 1, ARRAY['CA','CE']::text[], 1, NULL),
  ('CA', 1, ARRAY['CU','CE']::text[], 1, NULL),
  ('CE', 1, ARRAY[]::text[],          0, 'Chief Executive is terminal — no onward approval')
ON CONFLICT (originator_role_code, leg) DO UPDATE SET
  approver_role_codes = EXCLUDED.approver_role_codes,
  min_approvals       = EXCLUDED.min_approvals,
  note                = EXCLUDED.note,
  updated_at          = now();

CREATE INDEX IF NOT EXISTS idx_approval_route_originator ON public.approval_route (originator_role_code);
