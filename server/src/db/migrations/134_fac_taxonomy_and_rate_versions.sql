-- 134_fac_taxonomy_and_rate_versions.sql
-- Facultative taxonomy + reference-data versioning (design doc §4.5 M1/M6,
-- findings F1, F2, F12).
--
-- Part 1 — Taxonomy. fac_class_of_business.category groups classes for the
-- UI (checkbox headings, chip colours, which Extensions list to show) but
-- drives no maths. The redesign needs two groupings that do:
--
--   segment_code   how the book is organised, reported and reinsured
--   rating_family  what actually determines the pricing maths
--
-- They are orthogonal. Several segments share a family (Casualty and
-- Financial Lines both rate to a limit via ILFs) and one segment can span
-- families (Marine splits into hull values, transit turnover and
-- liability limits, which price nothing like each other). `category` is
-- left untouched and stays the display alias, so nothing that reads it
-- breaks.
--
-- Part 2 — Rate-table versions. Every fac reference table
-- (fac_occupancy_master, fac_factor_option, fac_natcat_rate,
-- fac_capacity_band, fac_bi_indemnity_loading, fac_territorial_capacity)
-- is upserted in place with no effective dating, so re-opening a quote
-- written before a rate revision silently recomputes it against today's
-- rates. fac_pricing snapshots the outputs, so the stored numbers are
-- safe — but the screen disagrees with them and nothing says why.
--
-- fac_rate_table_version gives the reference set an identity that a
-- priced row can point at. Full per-row effective dating (and the admin
-- UI that edits it) is a later phase; this is the identity + provenance
-- half, which is what makes historic quotes explainable today.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Taxonomy columns
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.fac_class_of_business
  ADD COLUMN IF NOT EXISTS segment_code   text,
  ADD COLUMN IF NOT EXISTS rating_family  text,
  ADD COLUMN IF NOT EXISTS exposure_basis text;

COMMENT ON COLUMN public.fac_class_of_business.segment_code IS
  'Organisational grouping (how the fac book is managed and reported).';
COMMENT ON COLUMN public.fac_class_of_business.rating_family IS
  'Technical grouping — selects the pricing family in shared/fac/registry.js.';
COMMENT ON COLUMN public.fac_class_of_business.exposure_basis IS
  'Units the family rates on: SI_PER_MILLE | CONTRACT_VALUE | AGREED_VALUE | TURNOVER | LIMIT_ILF | PER_UNIT.';

-- ── Backfill by class code, falling back to category ───────────────────────
-- Codes come from migration 053's seed. The CASE is explicit rather than
-- derived from `category` because category alone cannot separate hull from
-- cargo from marine liability, or project works from operational plant.
UPDATE public.fac_class_of_business SET
  segment_code = CASE
    WHEN code IN ('PAR','BC','AAR','BI','IAR')                THEN 'NON_MARINE_PROPERTY'
    WHEN code IN ('CAR','EAR','ALOP','EEI','MB','PARISK','CPM') THEN 'ENGINEERING_CONSTRUCTION'
    WHEN code IN ('HM','CARGO','GIT','STP','MLIA','PCGO')     THEN 'MARINE_TRANSIT'
    WHEN code IN ('EONS','EOFF','RENW')                       THEN 'ENERGY_POWER'
    WHEN code IN ('GL','PI','FG')                             THEN 'CASUALTY_LIABILITY'
    WHEN code IN ('MOT','PLIA')                               THEN 'MOTOR'
    WHEN code IN ('PA')                                       THEN 'ACCIDENT_HEALTH'
    WHEN code IN ('CY1','CY3')                                THEN 'FINANCIAL_SPECIALTY'
    WHEN category = 'PROPERTY'    THEN 'NON_MARINE_PROPERTY'
    WHEN category = 'ENGINEERING' THEN 'ENGINEERING_CONSTRUCTION'
    WHEN category = 'MARINE'      THEN 'MARINE_TRANSIT'
    WHEN category = 'ENERGY'      THEN 'ENERGY_POWER'
    WHEN category = 'CASUALTY'    THEN 'CASUALTY_LIABILITY'
    WHEN category = 'CYBER'       THEN 'FINANCIAL_SPECIALTY'
    ELSE 'NON_MARINE_PROPERTY'
  END,
  rating_family = CASE
    WHEN code IN ('PAR','BC','AAR','BI','IAR')     THEN 'SCHEDULE_PROPERTY'
    WHEN code IN ('CAR','EAR','ALOP','RENW','PCGO') THEN 'PROJECT_WORKS'
    WHEN code IN ('EEI','MB','PARISK','CPM')       THEN 'PLANT_OPERATIONAL'
    WHEN code IN ('HM')                            THEN 'HULL_VALUE'
    WHEN code IN ('CARGO','GIT','STP')             THEN 'TRANSIT_VALUES'
    WHEN code IN ('MLIA')                          THEN 'MARINE_LIABILITY'
    WHEN code IN ('EONS','EOFF')                   THEN 'ENERGY_ASSET'
    WHEN code IN ('GL','PI','FG')                  THEN 'LIABILITY_LIMIT'
    WHEN code IN ('MOT','PLIA')                    THEN 'MOTOR_FLEET'
    WHEN code IN ('PA')                            THEN 'PA_BENEFIT'
    WHEN code IN ('CY1','CY3')                     THEN 'CYBER_LIMIT'
    -- Anything unmapped rates as schedule property, which is what the
    -- single existing engine already did to every class.
    ELSE 'SCHEDULE_PROPERTY'
  END
WHERE segment_code IS NULL OR rating_family IS NULL;

-- Exposure basis follows from the family, so derive rather than restate.
UPDATE public.fac_class_of_business SET
  exposure_basis = CASE rating_family
    WHEN 'SCHEDULE_PROPERTY' THEN 'SI_PER_MILLE'
    WHEN 'PLANT_OPERATIONAL' THEN 'SI_PER_MILLE'
    WHEN 'ENERGY_ASSET'      THEN 'SI_PER_MILLE'
    WHEN 'PROJECT_WORKS'     THEN 'CONTRACT_VALUE'
    WHEN 'HULL_VALUE'        THEN 'AGREED_VALUE'
    WHEN 'TRANSIT_VALUES'    THEN 'TURNOVER'
    WHEN 'MARINE_LIABILITY'  THEN 'LIMIT_ILF'
    WHEN 'LIABILITY_LIMIT'   THEN 'LIMIT_ILF'
    WHEN 'CYBER_LIMIT'       THEN 'LIMIT_ILF'
    WHEN 'MOTOR_FLEET'       THEN 'PER_UNIT'
    WHEN 'PA_BENEFIT'        THEN 'PER_UNIT'
    ELSE 'SI_PER_MILLE'
  END
WHERE exposure_basis IS NULL;

CREATE INDEX IF NOT EXISTS idx_fac_cob_rating_family
  ON public.fac_class_of_business (rating_family);

-- Sections resolved their family from the class at save time; backfill the
-- rows migration 133 created before this taxonomy existed.
UPDATE public.fac_risk_section s
   SET rating_family = c.rating_family
  FROM public.fac_class_of_business c
 WHERE c.fac_cob_id = s.fac_cob_id
   AND s.rating_family IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Rate-table versions
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_rate_table_version (
  version_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_label  text NOT NULL UNIQUE,
  effective_from date NOT NULL,
  effective_to   date,               -- NULL = still current
  notes          text,
  created_at     timestamptz DEFAULT now(),
  CONSTRAINT fac_rate_table_version_range CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

-- Exactly one open-ended version at a time: that is "current".
CREATE UNIQUE INDEX IF NOT EXISTS uq_fac_rate_table_version_current
  ON public.fac_rate_table_version ((effective_to IS NULL))
  WHERE effective_to IS NULL;

-- The reference set as seeded by migration 078. Dated to that seed rather
-- than to now(), so a quote priced before this migration is attributed to
-- the rates it actually used.
INSERT INTO public.fac_rate_table_version (version_label, effective_from, notes)
VALUES (
  'FAC-REF-2026.1',
  DATE '2026-01-01',
  'Initial facultative property reference set (migration 078: occupancies, '
  || 'factor options and weights, capacity bands, BI indemnity loadings, '
  || 'natcat zone rates, territorial capacity).'
)
ON CONFLICT (version_label) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Provenance on the priced row
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.fac_pricing
  ADD COLUMN IF NOT EXISTS rate_table_version text,
  ADD COLUMN IF NOT EXISTS family_code        text,
  ADD COLUMN IF NOT EXISTS score_completeness numeric(7,4),
  ADD COLUMN IF NOT EXISTS exposure_basis     text;

COMMENT ON COLUMN public.fac_pricing.rate_table_version IS
  'fac_rate_table_version.version_label active when this row was priced.';
COMMENT ON COLUMN public.fac_pricing.family_code IS
  'Rating family that produced this row (shared/fac/registry.js).';
COMMENT ON COLUMN public.fac_pricing.score_completeness IS
  'Share of scoring weight actually selected, 0..1. Below the family floor no grade is issued.';
COMMENT ON COLUMN public.fac_pricing.exposure_basis IS
  'Which exposure source the premium was computed against: LOCATIONS | SECTIONS | RISK_HEADER.';

-- Rows priced before this migration all used the initial reference set.
UPDATE public.fac_pricing
   SET rate_table_version = 'FAC-REF-2026.1'
 WHERE rate_table_version IS NULL
   AND engine_version IS NOT NULL;
