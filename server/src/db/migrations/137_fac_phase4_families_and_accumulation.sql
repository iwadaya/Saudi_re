-- 137_fac_phase4_families_and_accumulation.sql
-- Facultative Phase 4: the last five families, the exposure they rate off,
-- and the accumulation check that has been missing since the module was
-- built. (Design doc §4.4, §4.5 M8, §4.9, finding F14.)
--
-- Part 1 — Engineering and Energy. PROJECT_WORKS rates a whole project
-- period off total contract value, not an annual rate on a sum insured;
-- PLANT_OPERATIONAL rates each item of plant on its own replacement value,
-- because a plant PML is item-level; ENERGY_ASSET is property mechanics
-- plus a process-hazard band, with Control of Well, OEE, pollution and
-- removal of wreck written as separately-rated sub-limits rather than
-- percentage loadings on the asset rate.
--
-- Part 2 — Cyber, Motor and Personal Accident. Cyber rates per million of
-- limit against a revenue band and a controls posture; motor rates per
-- vehicle-year by category with third-party liability stepped through the
-- ILF curves migration 136 already carries; PA rates per benefit unit by
-- occupational class.
--
-- Part 3 — Cyber dependency tagging. A cyber portfolio's real exposure is
-- not the sum of its limits, it is the largest common-vendor scenario. The
-- design makes tagging a MANDATORY gate rather than an option, so this is
-- the table the gate reads and the bind check enforces.
--
-- Part 4 — Accumulation (finding F14). `max_capacity_sar` has always
-- compared a risk against a STATIC territorial budget, never against the
-- capacity already committed in that zone by bound facultative risks and
-- inforce treaties. mv_fac_accumulation is that committed figure, and
-- fac_zone_budget is what it is measured against.
--
-- Every rate table here ships EMPTY, for the third phase running. A family
-- with nothing loaded reports itself unavailable with a reason naming the
-- table to load, takes no weight, and lets the blend carry on with whatever
-- does have data. A plausible default is worse than a refusal because
-- nobody goes looking for a number that looks right.
-- See docs/facultative-pricing-design.md §8.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. PROJECT_WORKS — CAR / EAR / offshore construction
-- ═══════════════════════════════════════════════════════════════════════════

-- The base rate is per mille of total contract value for the WHOLE project
-- period, banded by contract value because a $2bn project does not rate
-- like a $20m one. `period_factor_per_month` is the per-month loading
-- beyond a twelve-month baseline — a carrier parameter, so it is loaded and
-- not defaulted; absent, the period factor is 1.00 and the family says so.
CREATE TABLE IF NOT EXISTS public.fac_project_base_rate (
  rate_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_type       text NOT NULL,          -- CIVIL | BUILDING | POWER | OIL_GAS | MARINE_WORKS | …
  territory          text NOT NULL DEFAULT 'WORLDWIDE',
  contract_value_min numeric(18,2) NOT NULL DEFAULT 0,
  contract_value_max numeric(18,2),          -- NULL = open-ended top band
  rate_pm            numeric(12,6) NOT NULL,
  period_factor_per_month numeric(9,6),      -- loading per month beyond the baseline
  period_baseline_months  integer NOT NULL DEFAULT 12,
  source             text NOT NULL,
  effective_from     date NOT NULL DEFAULT CURRENT_DATE,
  effective_to       date,
  active             boolean NOT NULL DEFAULT true,
  CONSTRAINT fac_project_base_rate_band
    CHECK (contract_value_max IS NULL OR contract_value_max > contract_value_min)
);

CREATE INDEX IF NOT EXISTS idx_fac_project_base_rate_lookup
  ON public.fac_project_base_rate (project_type, territory, contract_value_min) WHERE active;

-- Project factors are ADDITIVE — the rate is base × (1 + Σ factors) — which
-- is how a construction slip is actually built up and rated. `loading` is a
-- fraction: 0.15 is +15%.
CREATE TABLE IF NOT EXISTS public.fac_project_factor (
  factor_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_kind text NOT NULL,   -- CONTRACTOR | METHOD | GROUND | WET_RISK | PHASING | SECURITY
  factor_key  text NOT NULL,
  loading     numeric(9,6) NOT NULL,
  source      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (factor_kind, factor_key)
);

-- Testing & commissioning, the maintenance period and DSU are separate
-- covers with separate exposure, so they carry separate rates rather than
-- percentages of the works rate. `per_unit` says what the rate multiplies.
CREATE TABLE IF NOT EXISTS public.fac_project_load_rate (
  load_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_kind text NOT NULL,   -- TESTING | MAINTENANCE | DSU
  load_key  text NOT NULL DEFAULT 'DEFAULT',  -- e.g. maintenance type, DSU driver profile
  rate_pm   numeric(12,6) NOT NULL,
  per_unit  text NOT NULL DEFAULT 'FLAT',     -- FLAT | WEEK | MONTH
  source    text NOT NULL,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (load_kind, load_key),
  CONSTRAINT fac_project_load_rate_unit CHECK (per_unit IN ('FLAT', 'WEEK', 'MONTH'))
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. PLANT_OPERATIONAL — machinery breakdown / EEI / CPM
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fac_plant_base_rate (
  rate_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_type text NOT NULL,
  territory    text NOT NULL DEFAULT 'WORLDWIDE',
  rate_pm      numeric(12,6) NOT NULL,
  source       text NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active       boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_fac_plant_base_rate_lookup
  ON public.fac_plant_base_rate (machine_type, territory) WHERE active;

-- Multiplicative, unlike the project factors: a twenty-year-old machine on
-- three shifts is not "base plus two loadings", it is a different risk.
CREATE TABLE IF NOT EXISTS public.fac_plant_factor (
  factor_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_kind text NOT NULL,   -- AGE | USAGE | MAINTENANCE | ENVIRONMENT
  factor_key  text NOT NULL,
  factor      numeric(9,4) NOT NULL CHECK (factor > 0),
  source      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (factor_kind, factor_key)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ENERGY_ASSET — onshore and offshore energy
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fac_energy_base_rate (
  rate_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_type    text NOT NULL,   -- REFINERY | PETROCHEM | UPSTREAM_ONSHORE | OFFSHORE_PLATFORM | POWER | RENEWABLE
  process_hazard_band text NOT NULL DEFAULT 'STANDARD',
  territory     text NOT NULL DEFAULT 'WORLDWIDE',
  rate_pm       numeric(12,6) NOT NULL,
  windstorm_season_load_pm numeric(12,6),   -- GoM-type named-windstorm exposure
  source        text NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active        boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_fac_energy_base_rate_lookup
  ON public.fac_energy_base_rate (asset_type, process_hazard_band, territory) WHERE active;

-- Sub-limits are separately-rated sections, never percentage loadings on the
-- asset rate. Control of Well on a deep-water well is not "the platform rate
-- plus fifteen percent"; it is its own exposure with its own limit.
CREATE TABLE IF NOT EXISTS public.fac_energy_sublimit_rate (
  sublimit_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sublimit_kind text NOT NULL,   -- CONTROL_OF_WELL | OEE | SEEPAGE_POLLUTION | REMOVAL_OF_WRECK | LOPI
  sublimit_key  text NOT NULL DEFAULT 'DEFAULT',
  rate_pm       numeric(12,6) NOT NULL,
  source        text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (sublimit_kind, sublimit_key)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. CYBER_LIMIT
-- ═══════════════════════════════════════════════════════════════════════════

-- Cyber quotes per million of limit, not per mille of anything: there is no
-- insured value. The rate scales with revenue band and industry, and the
-- ILF curves from migration 136 (family_code = 'CYBER_LIMIT') step it from
-- the basic limit to the limit written.
CREATE TABLE IF NOT EXISTS public.fac_cyber_base_rate (
  rate_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry_code    text NOT NULL DEFAULT 'ALL',
  revenue_min      numeric(18,2) NOT NULL DEFAULT 0,
  revenue_max      numeric(18,2),
  territory        text NOT NULL DEFAULT 'WORLDWIDE',
  basic_limit      numeric(18,2) NOT NULL,
  rate_per_million numeric(14,6) NOT NULL,
  source           text NOT NULL,
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  effective_to     date,
  active           boolean NOT NULL DEFAULT true,
  CONSTRAINT fac_cyber_base_rate_band
    CHECK (revenue_max IS NULL OR revenue_max > revenue_min),
  CONSTRAINT fac_cyber_base_rate_basic_limit CHECK (basic_limit > 0)
);

CREATE INDEX IF NOT EXISTS idx_fac_cyber_base_rate_lookup
  ON public.fac_cyber_base_rate (industry_code, revenue_min) WHERE active;

-- One row per control and posture: MFA=ENFORCED_ALL is a different factor
-- from MFA=PARTIAL. A control nobody has loaded a factor for contributes
-- nothing and is reported, rather than quietly discounting the price.
CREATE TABLE IF NOT EXISTS public.fac_cyber_control_factor (
  factor_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_key text NOT NULL,   -- MFA | EDR | BACKUPS | PATCHING | VENDOR_CONCENTRATION | TRAINING
  posture     text NOT NULL,
  factor      numeric(9,4) NOT NULL CHECK (factor > 0),
  source      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (control_key, posture)
);

-- The dependency tags the aggregation gate reads. Design doc §4.4: "every
-- cyber risk must be tagged with its critical vendor/cloud dependencies, and
-- the referral engine must check the portfolio's exposure to a common-vendor
-- scenario before bind."
CREATE TABLE IF NOT EXISTS public.fac_cyber_dependency (
  dependency_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id   uuid NOT NULL
                  REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  vendor_key    text NOT NULL,   -- normalised: AWS | AZURE | GCP | M365 | OKTA | …
  vendor_name   text,
  dependency_kind text NOT NULL DEFAULT 'CLOUD',  -- CLOUD | SAAS | MSP | PAYMENT | OTHER
  criticality   text NOT NULL DEFAULT 'CRITICAL', -- CRITICAL | IMPORTANT | INCIDENTAL
  notes         text,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (fac_risk_id, vendor_key)
);

CREATE INDEX IF NOT EXISTS idx_fac_cyber_dependency_vendor
  ON public.fac_cyber_dependency (vendor_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. MOTOR_FLEET and PA_BENEFIT
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fac_motor_base_rate (
  rate_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_category text NOT NULL,   -- PRIVATE | COMMERCIAL | HEAVY | SPECIAL | MOTORCYCLE
  territory        text NOT NULL DEFAULT 'WORLDWIDE',
  od_cost_per_vehicle_year  numeric(14,4),   -- own damage, per vehicle-year
  tpl_cost_per_vehicle_year numeric(14,4),   -- third-party liability at the basic limit
  tpl_basic_limit  numeric(18,2),            -- the limit the TPL cost is quoted at
  source           text NOT NULL,
  effective_from   date NOT NULL DEFAULT CURRENT_DATE,
  effective_to     date,
  active           boolean NOT NULL DEFAULT true,
  UNIQUE (vehicle_category, territory, effective_from)
);

CREATE TABLE IF NOT EXISTS public.fac_pa_base_rate (
  rate_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupational_class text NOT NULL,   -- typically 1–4, but free text: schemes differ
  cover_basis        text NOT NULL DEFAULT '24_HOUR',  -- 24_HOUR | OCCUPATIONAL
  territory          text NOT NULL DEFAULT 'WORLDWIDE',
  rate_per_unit      numeric(14,6) NOT NULL,   -- per unit of benefit
  source             text NOT NULL,
  effective_from     date NOT NULL DEFAULT CURRENT_DATE,
  effective_to       date,
  active             boolean NOT NULL DEFAULT true,
  CONSTRAINT fac_pa_base_rate_basis CHECK (cover_basis IN ('24_HOUR', 'OCCUPATIONAL'))
);

CREATE INDEX IF NOT EXISTS idx_fac_pa_base_rate_lookup
  ON public.fac_pa_base_rate (occupational_class, cover_basis, territory) WHERE active;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Project earning pattern
-- ═══════════════════════════════════════════════════════════════════════════

-- A construction premium is 100% at inception but earns over the project
-- period, and not evenly: an S-curve matches how values are erected on site.
-- The portfolio view cannot earn it correctly without knowing which.
ALTER TABLE public.fac_risk
  ADD COLUMN IF NOT EXISTS earning_pattern text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fac_risk_earning_pattern_check'
  ) THEN
    ALTER TABLE public.fac_risk
      ADD CONSTRAINT fac_risk_earning_pattern_check
      CHECK (earning_pattern IS NULL OR earning_pattern IN ('STRAIGHT_LINE', 'S_CURVE'));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6b. The technical rate, persisted
-- ═══════════════════════════════════════════════════════════════════════════

-- Phase 2 stored the build-up's inputs (blended loss cost, loads, weights)
-- but not its answer, so a portfolio view had to re-price every risk to work
-- out whether the book was priced above or below technical. Both columns are
-- written by the same save that writes the rest of the build-up.
ALTER TABLE public.fac_pricing
  ADD COLUMN IF NOT EXISTS technical_gross_rate_pm numeric(14,8),
  ADD COLUMN IF NOT EXISTS technical_adequacy      numeric(9,4);

COMMENT ON COLUMN public.fac_pricing.technical_adequacy IS
  'Quoted rate ÷ technical gross rate. Above 1.00 the price is ahead of the model.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Accumulation (finding F14)
-- ═══════════════════════════════════════════════════════════════════════════

-- What the zone can hold. Ships EMPTY: a budget is an appetite decision, and
-- inventing one would make the gate look like it was working when it was
-- only guessing. With no budget loaded the check reports committed exposure
-- and says no budget is set, which is a true and useful answer.
CREATE TABLE IF NOT EXISTS public.fac_zone_budget (
  budget_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cresta_zone text NOT NULL,
  country_id  uuid REFERENCES public.country(country_id),
  peril       text NOT NULL DEFAULT 'ALL',   -- ALL | EQ | WS | FLOOD | SRCC
  uw_year     integer,                        -- NULL = applies to every year
  budget_si   numeric(18,2),
  budget_pml  numeric(18,2),
  source      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (cresta_zone, peril, uw_year)
);

-- Committed exposure by zone. Two legs, because a carrier's capacity is
-- consumed by both: bound facultative risks at the carrier's own share, and
-- the CRESTA aggregates already declared on inforce treaties.
--
-- The facultative leg takes the carrier's share of each location's PML,
-- falling back to the risk-level share when a location does not carry its
-- own. PML percentages default to 100% — an unstated PML is a total loss
-- until somebody says otherwise, which is the conservative reading and the
-- only safe one for an accumulation control.
DROP MATERIALIZED VIEW IF EXISTS public.mv_fac_accumulation;
CREATE MATERIALIZED VIEW public.mv_fac_accumulation AS
  SELECT
    l.cresta_zone,
    r.country_id,
    COALESCE(c.rating_family, 'SCHEDULE_PROPERTY') AS rating_family,
    r.uw_year,
    'FAC'::text AS source_kind,
    SUM(
      (COALESCE(l.pd_si, 0) + COALESCE(l.bi_si, 0))
      * COALESCE(l.carrier_pd_share_pct, r.our_share_pct, r.ri_share_pct, 1)
    ) AS committed_si,
    SUM(
      COALESCE(l.pd_si, 0) * COALESCE(l.pd_pml_pct, 1)
      * COALESCE(l.carrier_pd_share_pct, r.our_share_pct, r.ri_share_pct, 1)
      + COALESCE(l.bi_si, 0) * COALESCE(l.bi_pml_pct, 1)
      * COALESCE(l.carrier_bi_share_pct, l.carrier_pd_share_pct, r.our_share_pct, r.ri_share_pct, 1)
    ) AS committed_pml,
    COUNT(DISTINCT r.fac_risk_id) AS risk_count
  FROM public.fac_risk r
  JOIN public.fac_location l ON l.fac_risk_id = r.fac_risk_id
  LEFT JOIN public.fac_class_of_business c ON c.fac_cob_id = r.fac_cob_id
  WHERE r.status = 'BOUND'
    AND l.cresta_zone IS NOT NULL
    AND l.cresta_zone <> ''
  GROUP BY 1, 2, 3, 4

  UNION ALL

  SELECT
    d.zone_id AS cresta_zone,
    d.country_id,
    'TREATY'::text AS rating_family,
    ct.uw_year,
    'TREATY'::text AS source_kind,
    SUM(COALESCE(d.eq_agg,0) + COALESCE(d.ws_agg,0) + COALESCE(d.flood_agg,0)
        + COALESCE(d.srcc_agg,0) + COALESCE(d.others_agg,0)) AS committed_si,
    NULL::numeric AS committed_pml,
    COUNT(DISTINCT ct.contract_id) AS risk_count
  FROM public.contract ct
  JOIN public.contract_cresta_data d ON d.contract_id = ct.contract_id
  WHERE d.zone_id IS NOT NULL AND d.zone_id <> ''
  GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fac_accumulation_key
  ON public.mv_fac_accumulation (cresta_zone, rating_family, source_kind, uw_year, country_id);
