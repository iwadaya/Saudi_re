-- 077_fac_property_reference_data.sql
-- Facultative property reference-data schema: occupancy master, factor
-- catalogue + weighting, hazard / frequency scoring, territorial capacity,
-- capacity bands, BI indemnity loadings, natcat rates, clause master.
-- No seed data in this migration.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Occupancy master
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_occupancy_master (
  occupancy_code      integer PRIMARY KEY,
  occupancy_name      text NOT NULL,
  industry_type       text,
  hazard_grade        integer CHECK (hazard_grade BETWEEN 1 AND 10),
  hazard_category     text,
  risk_category       integer,
  frequency_category  integer,
  flexa_rate          numeric(8,4),
  flexa_base_rate_pm  numeric(8,4),
  active              boolean DEFAULT true,
  sort_order          integer
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Factor master + options + weights
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_factor_master (
  factor_code     text PRIMARY KEY,
  factor_name     text NOT NULL,
  sort_order      integer,
  affects_rate    boolean DEFAULT true,
  affects_score   boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.fac_factor_option (
  option_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_code       text REFERENCES public.fac_factor_master(factor_code),
  option_label      text NOT NULL,
  score             integer,
  discount_loading  numeric(7,4),
  sort_order        integer,
  UNIQUE (factor_code, option_label)
);

CREATE TABLE IF NOT EXISTS public.fac_factor_weight (
  weight_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme       text NOT NULL,
  factor_code  text REFERENCES public.fac_factor_master(factor_code),
  weight       numeric(7,5) NOT NULL,
  UNIQUE (scheme, factor_code)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Scoring lookups (hazard grade, frequency)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_hazard_grade_score (
  hazard_grade  integer PRIMARY KEY,
  score         integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fac_frequency_score (
  frequency_category  integer PRIMARY KEY,
  score               integer NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Territorial capacity & capacity bands
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_territorial_capacity (
  region        text PRIMARY KEY,
  max_capacity  numeric(18,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fac_capacity_band (
  band_id              serial PRIMARY KEY,
  score_min            integer NOT NULL,
  score_max            integer NOT NULL,
  grade                text NOT NULL,
  description          text,
  max_capacity_pct     numeric(5,4),
  min_tech_rate_pm     numeric(7,4),
  underwriting_action  text
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. BI indemnity loading
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_bi_indemnity_loading (
  indemnity_months    integer PRIMARY KEY,
  base_rate_loading   numeric(6,3) NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Natcat rates
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_natcat_rate (
  rate_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_zone       text UNIQUE NOT NULL,
  flood_storm_rate   numeric(8,4),
  earthquake_rate    numeric(8,4),
  active             boolean DEFAULT true
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Clause master
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_clause_master (
  clause_code      text PRIMARY KEY,
  clause_name      text NOT NULL,
  clause_category  text,
  is_mandatory     boolean DEFAULT true,
  sort_order       integer
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Indexes
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_fac_occupancy_master_active_name
  ON public.fac_occupancy_master (active, occupancy_name);

CREATE INDEX IF NOT EXISTS idx_fac_natcat_rate_active_zone
  ON public.fac_natcat_rate (active, country_zone);
