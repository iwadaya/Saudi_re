-- 053_facultative_schema.sql
-- Facultative reinsurance module: risks, locations, COPE, loss history,
-- dual pricing engine (market + actuarial), documents, market rate benchmarks.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Fac-specific classes of business (separate from treaty COBs)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_class_of_business (
    fac_cob_id   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    class_name   text NOT NULL,
    category     text NOT NULL,  -- PROPERTY, ENGINEERING, MARINE, CASUALTY, CYBER, ENERGY
    code         text,
    is_project   boolean DEFAULT false,  -- true for CAR/EAR one-off project policies
    created_at   timestamptz DEFAULT now()
);

-- Seed fac classes
INSERT INTO public.fac_class_of_business (class_name, category, code, is_project) VALUES
  -- Property / Fire
  ('Property All Risks',          'PROPERTY',    'PAR',  false),
  ('Buildings Combined',          'PROPERTY',    'BC',   false),
  ('Assets All Risks',            'PROPERTY',    'AAR',  false),
  ('Business Interruption',       'PROPERTY',    'BI',   false),
  ('Industrial All Risks',        'PROPERTY',    'IAR',  false),
  -- Engineering
  ('Construction All Risks',      'ENGINEERING', 'CAR',  true),
  ('Erection All Risks',          'ENGINEERING', 'EAR',  true),
  ('ALoP / DSU',                  'ENGINEERING', 'ALOP', true),
  ('Electronic Equipment',        'ENGINEERING', 'EEI',  false),
  ('Machinery Breakdown',         'ENGINEERING', 'MB',   false),
  ('Plant All Risks',             'ENGINEERING', 'PARISK', false),
  ('Contractors Plant & Machinery','ENGINEERING','CPM',  false),
  -- Marine
  ('Hull & Machinery',            'MARINE',      'HM',   false),
  ('Cargo Insurance',             'MARINE',      'CARGO',false),
  ('Goods in Transit',            'MARINE',      'GIT',  false),
  ('Stock Throughput',            'MARINE',      'STP',  false),
  ('Marine Liability',            'MARINE',      'MLIA', false),
  ('Project Cargo',               'MARINE',      'PCGO', true),
  -- Casualty
  ('General Liability',           'CASUALTY',    'GL',   false),
  ('Professional Indemnity',      'CASUALTY',    'PI',   false),
  ('Motor',                       'CASUALTY',    'MOT',  false),
  ('Fidelity Guarantee',          'CASUALTY',    'FG',   false),
  ('Personal Accident',           'CASUALTY',    'PA',   false),
  ('Passenger Liability',         'CASUALTY',    'PLIA', false),
  -- Cyber
  ('Cyber - First Party',         'CYBER',       'CY1',  false),
  ('Cyber - Third Party',         'CYBER',       'CY3',  false),
  -- Energy
  ('Energy Onshore',              'ENERGY',      'EONS', false),
  ('Energy Offshore',             'ENERGY',      'EOFF', false),
  ('Renewable Energy',            'ENERGY',      'RENW', true)
ON CONFLICT DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Fac risk — the core table (equivalent of "contract" for treaty)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TYPE public.fac_status AS ENUM (
    'DRAFT','QUOTED','REFERRED','BOUND','DECLINED','NTU','CANCELLED','RENEWED'
);

CREATE TYPE public.fac_placement_type AS ENUM (
    'PROPORTIONAL','NON_PROPORTIONAL'
);

CREATE TABLE IF NOT EXISTS public.fac_risk (
    fac_risk_id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_ref             text,   -- auto-generated FAC-YYYY-NNN

    -- Parties (linked to existing treaty tables)
    cedant_id           uuid REFERENCES public.companies(company_id),
    broker_id           uuid REFERENCES public.brokers(broker_id),
    country_id          uuid REFERENCES public.country(country_id),
    currency_id         uuid REFERENCES public.currency(currency_id),

    -- Insured / risk identity
    insured_name        text NOT NULL,
    insured_address     text,
    nature_of_business  text,   -- occupation description
    fac_cob_id          uuid REFERENCES public.fac_class_of_business(fac_cob_id),

    -- Policy
    inception_date      date,
    expiry_date         date,
    policy_period_months integer DEFAULT 12,
    uw_year             integer,

    -- Sums insured (100% basis)
    total_sum_insured   numeric(18,2) DEFAULT 0,
    pd_sum_insured      numeric(18,2) DEFAULT 0,  -- physical damage
    bi_sum_insured      numeric(18,2) DEFAULT 0,  -- business interruption

    -- Placement structure
    placement_type      public.fac_placement_type DEFAULT 'PROPORTIONAL',
    -- Proportional fields
    cedant_retention_pct  numeric(9,6),   -- e.g. 20%
    ri_share_pct          numeric(9,6),   -- e.g. 80%
    our_share_pct         numeric(9,6),   -- our signed share of the RI portion
    -- Non-proportional fields
    np_retention          numeric(18,2),  -- deductible / priority
    np_limit              numeric(18,2),  -- cover limit xs retention
    np_our_share_pct      numeric(9,6),   -- our share of the XL layer

    -- Deductibles
    deductible_amount     numeric(18,2),
    deductible_description text,

    -- Commission & brokerage
    commission_pct      numeric(9,6),
    brokerage_pct       numeric(9,6),
    taxes_pct           numeric(9,6),

    -- Premium (100% basis)
    original_premium    numeric(18,2),  -- cedant's original gross premium
    ri_premium          numeric(18,2),  -- reinsurance premium (our share)
    original_rate       numeric(12,8),  -- rate per mille on SI

    -- PML / MFL
    pml_amount          numeric(18,2),
    pml_pct             numeric(9,6),
    mfl_amount          numeric(18,2),
    mfl_pct             numeric(9,6),

    -- Status & workflow
    status              public.fac_status DEFAULT 'DRAFT',
    created_by_user_id  uuid REFERENCES public.uw_user(user_id),
    assigned_to_user_id uuid REFERENCES public.uw_user(user_id),

    -- Link to treaty (same cedant)
    linked_contract_id  uuid REFERENCES public.contract(contract_id),

    -- Notes
    underwriter_notes   text,
    decline_reason      text,
    ntu_reason          text,

    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);

-- Auto-generate fac_ref on insert
CREATE OR REPLACE FUNCTION public.fac_ref_generate()
RETURNS trigger AS $$
DECLARE
    yr integer;
    seq integer;
BEGIN
    yr := COALESCE(NEW.uw_year, EXTRACT(YEAR FROM COALESCE(NEW.inception_date, now())));
    SELECT COALESCE(MAX(
        CASE WHEN fac_ref ~ ('^FAC-' || yr || '-\d+$')
             THEN CAST(SPLIT_PART(fac_ref, '-', 3) AS integer)
             ELSE 0 END
    ), 0) + 1 INTO seq FROM public.fac_risk;
    NEW.fac_ref := 'FAC-' || yr || '-' || LPAD(seq::text, 4, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fac_ref ON public.fac_risk;
CREATE TRIGGER trg_fac_ref
    BEFORE INSERT ON public.fac_risk
    FOR EACH ROW
    WHEN (NEW.fac_ref IS NULL)
    EXECUTE FUNCTION public.fac_ref_generate();

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.fac_risk_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fac_risk_updated ON public.fac_risk;
CREATE TRIGGER trg_fac_risk_updated
    BEFORE UPDATE ON public.fac_risk
    FOR EACH ROW
    EXECUTE FUNCTION public.fac_risk_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Fac locations — per-site SI breakdown (PD + BI per location)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_location (
    location_id     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_risk_id     uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
    location_name   text,
    address         text,
    latitude        numeric(10,7),
    longitude       numeric(10,7),
    cresta_zone     text,
    country_id      uuid REFERENCES public.country(country_id),
    pd_si           numeric(18,2) DEFAULT 0,
    bi_si           numeric(18,2) DEFAULT 0,
    total_si        numeric(18,2) GENERATED ALWAYS AS (pd_si + bi_si) STORED,
    sort_order      integer DEFAULT 0,
    created_at      timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. COPE details — Construction, Occupation, Protection, Exposure
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_cope (
    cope_id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_risk_id     uuid NOT NULL UNIQUE REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,

    -- Construction
    construction_type       text,  -- Standard / Non-Standard / Fire Resistive / etc.
    construction_year       integer,
    fire_walls              boolean,
    fire_doors              boolean,
    spatial_separation_m    numeric(8,2),
    roof_material           text,
    wall_material           text,
    floors                  integer,
    total_area_sqm          numeric(12,2),

    -- Occupation
    occupation_description  text,
    process_description     text,
    hazard_grade            text,  -- Low / Medium / High / Very High
    operating_hours         text,  -- 24/7 / Shift / Day only

    -- Protection
    sprinkler_system        boolean DEFAULT false,
    sprinkler_type          text,   -- Wet / Dry / Deluge / None
    fire_alarm              boolean DEFAULT false,
    fire_brigade_distance_km numeric(6,2),
    extinguishers           boolean DEFAULT true,
    hydrants                boolean DEFAULT false,
    cctv                    boolean DEFAULT false,
    security_guards         boolean DEFAULT false,

    -- Exposure
    natcat_earthquake       boolean DEFAULT false,
    natcat_flood            boolean DEFAULT false,
    natcat_windstorm        boolean DEFAULT false,
    natcat_other            text,
    exposure_notes          text,

    -- Survey
    survey_date             date,
    survey_provider         text,
    survey_rating           text,  -- Excellent / Good / Fair / Poor

    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Fac loss history — min 3 years FGU (from the ground up)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_loss_history (
    loss_id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_risk_id     uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
    loss_year       integer NOT NULL,
    loss_date       date,
    loss_description text,
    cause_of_loss   text,
    fgu_paid        numeric(18,2) DEFAULT 0,
    fgu_outstanding numeric(18,2) DEFAULT 0,
    fgu_incurred    numeric(18,2) GENERATED ALWAYS AS (fgu_paid + fgu_outstanding) STORED,
    ri_paid         numeric(18,2) DEFAULT 0,
    ri_outstanding  numeric(18,2) DEFAULT 0,
    ri_incurred     numeric(18,2) GENERATED ALWAYS AS (ri_paid + ri_outstanding) STORED,
    mitigation_measures text,
    is_open         boolean DEFAULT true,
    created_at      timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Fac market rates — reference table for average market rates by class
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_market_rate (
    market_rate_id  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_cob_id      uuid REFERENCES public.fac_class_of_business(fac_cob_id),
    region          text,   -- GCC, MENA, Africa, Asia, Global
    hazard_grade    text,   -- Low, Medium, High
    rate_per_mille  numeric(12,8),  -- benchmark rate ‰
    effective_date  date DEFAULT CURRENT_DATE,
    source          text,   -- e.g. "Market Average 2026", "Swiss Re benchmark"
    created_at      timestamptz DEFAULT now()
);

-- Seed some baseline market rates (‰ of SI)
INSERT INTO public.fac_market_rate (fac_cob_id, region, hazard_grade, rate_per_mille, source)
SELECT c.fac_cob_id, r.region, h.grade, r.base * h.mult, 'Benchmark 2026'
FROM public.fac_class_of_business c
CROSS JOIN (VALUES ('GCC', 0.50), ('MENA', 0.60), ('Africa', 0.80), ('Asia', 0.55), ('Global', 0.65)) AS r(region, base)
CROSS JOIN (VALUES ('Low', 0.7), ('Medium', 1.0), ('High', 1.6)) AS h(grade, mult)
WHERE c.category = 'PROPERTY'
ON CONFLICT DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Fac pricing — dual engine: market rate + actuarial, blended
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_pricing (
    pricing_id      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_risk_id     uuid NOT NULL UNIQUE REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,

    -- Market pricing
    market_rate_per_mille   numeric(12,8),
    market_premium          numeric(18,2),
    market_source           text,

    -- Actuarial pricing (experience-based / exposure-based)
    actuarial_method        text,  -- BURNING_COST, EXPOSURE_RATED, FREQUENCY_SEVERITY
    actuarial_rate_per_mille numeric(12,8),
    actuarial_premium       numeric(18,2),
    expected_loss_ratio     numeric(9,6),
    loss_cost               numeric(18,2),
    loading_pct             numeric(9,6),  -- expense + profit loading

    -- Blend
    market_weight_pct       numeric(9,6) DEFAULT 50,
    actuarial_weight_pct    numeric(9,6) DEFAULT 50,
    blended_rate_per_mille  numeric(12,8),
    blended_premium         numeric(18,2),

    -- Final UW decision
    final_rate_per_mille    numeric(12,8),
    final_premium           numeric(18,2),
    uw_adjustment_pct       numeric(9,6) DEFAULT 0,
    uw_adjustment_reason    text,

    -- Technicals
    burning_cost_ratio      numeric(9,6),
    avg_loss_years          integer DEFAULT 5,

    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Fac documents — survey reports, policy wording, slips
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_document (
    document_id     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    fac_risk_id     uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
    doc_type        text NOT NULL,  -- SURVEY_REPORT, POLICY_WORDING, SLIP, RISK_NOTE, LOSS_REPORT, OTHER
    file_name       text,
    file_path       text,
    file_size       integer,
    mime_type       text,
    uploaded_by     uuid REFERENCES public.uw_user(user_id),
    notes           text,
    created_at      timestamptz DEFAULT now()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Indexes
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_fac_risk_cedant      ON public.fac_risk(cedant_id);
CREATE INDEX IF NOT EXISTS idx_fac_risk_status      ON public.fac_risk(status);
CREATE INDEX IF NOT EXISTS idx_fac_risk_uw_year     ON public.fac_risk(uw_year);
CREATE INDEX IF NOT EXISTS idx_fac_risk_assigned    ON public.fac_risk(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_fac_risk_cob         ON public.fac_risk(fac_cob_id);
CREATE INDEX IF NOT EXISTS idx_fac_risk_linked      ON public.fac_risk(linked_contract_id);
CREATE INDEX IF NOT EXISTS idx_fac_location_risk    ON public.fac_location(fac_risk_id);
CREATE INDEX IF NOT EXISTS idx_fac_cope_risk        ON public.fac_cope(fac_risk_id);
CREATE INDEX IF NOT EXISTS idx_fac_loss_risk        ON public.fac_loss_history(fac_risk_id);
CREATE INDEX IF NOT EXISTS idx_fac_pricing_risk     ON public.fac_pricing(fac_risk_id);
CREATE INDEX IF NOT EXISTS idx_fac_document_risk    ON public.fac_document(fac_risk_id);
CREATE INDEX IF NOT EXISTS idx_fac_market_rate_cob  ON public.fac_market_rate(fac_cob_id);
