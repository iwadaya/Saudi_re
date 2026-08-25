-- 143_retro_module.sql
-- Retro module foundation: outwards retrocession programmes managed per
-- underwriting year by the Retro Manager.
--
--   • retro_programme         — one row per outwards programme per UW year
--     (QS / surplus / XL / stop loss …) with its limits, attachment,
--     cession and cost terms. Scope is by class of business and country
--     via the two join tables below; covers_all_* short-circuits the join
--     for whole-account programmes.
--   • retro_programme_class   — classes of business the programme protects.
--   • retro_programme_country — countries the programme protects.
--   • retro_pack_document     — the "retro pack": placement slips, cover
--     notes, security schedules … attached to a programme. Mirrors
--     claim_document; bytes go through the shared lib/uploadStorage.js sink,
--     this table only records the pointer.
--
-- Access: a new 'Retro Manager' (RM) role is seeded at hierarchy level 3 —
-- writes to the module are gated server-side to RM or level ≤ 2 (CE/CU/CA);
-- every authenticated user can READ the module (that is the point: it shows
-- underwriters their outwards limits by country × class and whether a treaty
-- they are writing has retro behind it).
--
-- Audit: writes log to the generic public.audit_log (entity_type
-- 'RETRO_PROGRAMME') via services/audit.logAudit — no new audit tables.

-- ── retro_programme ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.retro_programme (
  retro_programme_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uw_year             integer NOT NULL CHECK (uw_year BETWEEN 1990 AND 2100),
  programme_name      text NOT NULL,
  programme_type      text NOT NULL DEFAULT 'XL_PER_RISK'
                      CHECK (programme_type IN
                        ('QUOTA_SHARE','SURPLUS','XL_PER_RISK','XL_CAT',
                         'XL_AGGREGATE','STOP_LOSS','WHOLE_ACCOUNT_XL','OTHER')),
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','CANCELLED')),
  reinsurer           text,                              -- lead reinsurer / market
  currency_code       text NOT NULL DEFAULT 'USD',
  -- Proportional terms
  cession_pct         numeric(9,4)  CHECK (cession_pct    IS NULL OR (cession_pct    >= 0 AND cession_pct    <= 100)),
  commission_pct      numeric(9,4)  CHECK (commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100)),
  -- XL terms
  attachment          numeric(20,2) CHECK (attachment      IS NULL OR attachment      >= 0),
  occurrence_limit    numeric(20,2) CHECK (occurrence_limit IS NULL OR occurrence_limit >= 0),
  aggregate_limit     numeric(20,2) CHECK (aggregate_limit IS NULL OR aggregate_limit >= 0),
  reinstatements      integer       CHECK (reinstatements  IS NULL OR reinstatements  >= 0),
  rol_pct             numeric(9,4)  CHECK (rol_pct         IS NULL OR rol_pct         >= 0),
  -- Spend at our net level
  premium             numeric(20,2) CHECK (premium IS NULL OR premium >= 0),
  inception_date      date,
  expiry_date         date,
  covers_all_classes  boolean NOT NULL DEFAULT false,
  covers_all_countries boolean NOT NULL DEFAULT false,
  notes               text,
  created_by_user_id  uuid REFERENCES public.uw_user(user_id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (uw_year, programme_name)
);

CREATE INDEX IF NOT EXISTS idx_retro_programme_year   ON public.retro_programme(uw_year);
CREATE INDEX IF NOT EXISTS idx_retro_programme_status ON public.retro_programme(status);

-- ── Scope joins ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.retro_programme_class (
  retro_programme_id   uuid NOT NULL REFERENCES public.retro_programme(retro_programme_id) ON DELETE CASCADE,
  class_of_business_id uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  PRIMARY KEY (retro_programme_id, class_of_business_id)
);

CREATE TABLE IF NOT EXISTS public.retro_programme_country (
  retro_programme_id uuid NOT NULL REFERENCES public.retro_programme(retro_programme_id) ON DELETE CASCADE,
  country_id         uuid NOT NULL REFERENCES public.country(country_id),
  PRIMARY KEY (retro_programme_id, country_id)
);

CREATE INDEX IF NOT EXISTS idx_retro_prog_class_cob    ON public.retro_programme_class(class_of_business_id);
CREATE INDEX IF NOT EXISTS idx_retro_prog_country_ctry ON public.retro_programme_country(country_id);

-- ── Retro packs (documents) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.retro_pack_document (
  document_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retro_programme_id  uuid NOT NULL REFERENCES public.retro_programme(retro_programme_id) ON DELETE CASCADE,
  file_name           text NOT NULL,
  mime_type           text,
  size_bytes          bigint,
  storage_path        text NOT NULL,
  title               text,
  description         text,
  uploaded_by_user_id uuid REFERENCES public.uw_user(user_id),
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retro_pack_document_prog ON public.retro_pack_document(retro_programme_id);

-- ── Retro Manager role ──────────────────────────────────────────────────────
-- Same manager tier as the Underwriting Manager; can_override_below is
-- irrelevant to the retro module but kept consistent with that tier.

INSERT INTO public.uw_role (role_name, role_code, hierarchy_level, can_override_below, display_order, limit_basis)
VALUES ('Retro Manager', 'RM', 3, false, 35, 'SIGNED_EXPOSURE')
ON CONFLICT (role_name) DO UPDATE SET
  role_code       = EXCLUDED.role_code,
  hierarchy_level = EXCLUDED.hierarchy_level,
  display_order   = EXCLUDED.display_order,
  updated_at      = now();

-- ── Demo persona ─────────────────────────────────────────────────────────────
-- retro.manager / demo2026 — same shared-demo scrypt hash as migration 132's
-- personas so the module can be exercised in any environment.

DO $$
DECLARE
  pw CONSTANT text := 'scrypt$15$8$1$eff2fdc2db41c974beacfe9ef7438095$ffb1f7448e77c8d6784c4c118c85482c16e8729d6f385102cc84413a16a5706d722155d803e808e574407e12d894951544807385eb36c7d1f52d8a83ca3f50b7';
  v_role_rm uuid;
BEGIN
  SELECT role_id INTO v_role_rm FROM public.uw_role WHERE role_code = 'RM' LIMIT 1;
  IF v_role_rm IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.uw_user WHERE username = 'retro.manager') THEN
    INSERT INTO public.uw_user
      (email, username, display_name, role_id, password_hash, must_change_password, is_active)
    VALUES
      ('retro.manager@universe3.app', 'retro.manager', 'Retro Manager', v_role_rm, pw, false, true);
  END IF;
END $$;
