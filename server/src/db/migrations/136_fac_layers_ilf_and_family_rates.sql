-- 136_fac_layers_ilf_and_family_rates.sql
-- Facultative Phase 3: layered placements, increased limit factors, and the
-- reference rates the three new families price from.
-- (Design doc §4.5 M4 + §4.4, findings F2 and F3.)
--
-- Part 1 — Layers. fac_risk has carried np_retention / np_limit /
-- np_our_share_pct since the module was built and nothing has ever priced a
-- layer with them (finding F3). One retention and one limit also cannot
-- describe a tower, which is how excess casualty and most marine liability
-- is actually placed. fac_layer is that structure, with the reinstatement
-- terms an XL placement is bought and sold on.
--
-- Part 2 — Increased limit factors. Casualty has no sum insured; the loss
-- cost is a basic-limit rate stepped up to the policy limit by an ILF curve.
-- The curve maths is published and implemented in shared/fac; the curve
-- PARAMETERS are a view about severity that belongs to whoever holds the
-- data behind them, so they are loaded here rather than invented.
--
-- Part 3 — Family base rates. Each new family rates off a table a carrier
-- owns: liability off exposure units, cargo off turnover by commodity and
-- route, hull off agreed value by vessel type and tonnage. All three ship
-- EMPTY. A family with no rates loaded reports itself unavailable with a
-- reason, exactly as the exposure-curve method does — the alternative is a
-- number nobody can attribute, which is the problem this whole redesign
-- exists to fix. See docs/facultative-pricing-design.md §8.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Layers
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_layer (
  layer_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id     uuid NOT NULL
                    REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  section_id      uuid REFERENCES public.fac_risk_section(section_id) ON DELETE CASCADE,
  layer_no        integer NOT NULL CHECK (layer_no BETWEEN 1 AND 50),

  attachment      numeric(18,2) NOT NULL DEFAULT 0,
  limit_amount    numeric(18,2),          -- NULL = unlimited top layer
  our_share_pct   numeric(9,6),

  -- Reinstatements. `reinstatements` NULL means unlimited free; 0 means none.
  -- terms is one entry per reinstatement: {pct_of_premium, pro_rata_time,
  -- pro_rata_amount} — the shape an XL slip actually states them in.
  reinstatements  integer CHECK (reinstatements IS NULL OR reinstatements >= 0),
  reinstatement_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  aggregate_limit numeric(18,2),

  -- Priced outputs, kept so a tower renders without re-running the engine.
  loss_cost       numeric(18,2),
  rol_pct         numeric(9,6),
  premium         numeric(18,2),
  notes           text,

  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),

  CONSTRAINT fac_layer_unique UNIQUE (fac_risk_id, section_id, layer_no),
  CONSTRAINT fac_layer_limit_positive CHECK (limit_amount IS NULL OR limit_amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_fac_layer_risk ON public.fac_layer (fac_risk_id, layer_no);

CREATE OR REPLACE FUNCTION public.fac_layer_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fac_layer_touch ON public.fac_layer;
CREATE TRIGGER trg_fac_layer_touch
  BEFORE UPDATE ON public.fac_layer
  FOR EACH ROW EXECUTE FUNCTION public.fac_layer_touch();

-- Existing single-layer placements become layer 1, so nothing that was
-- already entered is stranded outside the new structure.
INSERT INTO public.fac_layer (fac_risk_id, layer_no, attachment, limit_amount, our_share_pct)
SELECT r.fac_risk_id, 1, COALESCE(r.np_retention, 0), r.np_limit, r.np_our_share_pct
FROM public.fac_risk r
WHERE r.placement_type = 'NON_PROPORTIONAL'
  AND r.np_limit IS NOT NULL
  AND r.np_limit > 0
ON CONFLICT ON CONSTRAINT fac_layer_unique DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Increased limit factors
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_ilf_curve (
  curve_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curve_code    text NOT NULL UNIQUE,
  curve_name    text NOT NULL,
  family_code   text,          -- NULL = usable by any limit-rated family
  territory     text,          -- US-exposed liability behaves nothing like the rest
  source        text NOT NULL, -- required: a curve nobody can attribute is a rate nobody can defend
  kind          text NOT NULL DEFAULT 'POWER',   -- POWER (Riebesell) | TABULATED
  basic_limit   numeric(18,2) NOT NULL,
  -- POWER: {doubling_loading} or {alpha}. Riebesell's rule — doubling the
  -- limit raises the risk premium by a fixed percentage whatever the limit —
  -- gives alpha = log2(1 + doubling_loading).
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz DEFAULT now(),
  CONSTRAINT fac_ilf_curve_kind CHECK (kind IN ('POWER', 'TABULATED')),
  CONSTRAINT fac_ilf_curve_basic_limit CHECK (basic_limit > 0)
);

-- Tabulated ILFs, for the classes where a published table beats a smooth
-- curve (US-exposed liability in particular).
CREATE TABLE IF NOT EXISTS public.fac_ilf_point (
  curve_id uuid NOT NULL REFERENCES public.fac_ilf_curve(curve_id) ON DELETE CASCADE,
  limit_amount numeric(18,2) NOT NULL CHECK (limit_amount > 0),
  ilf          numeric(12,6) NOT NULL CHECK (ilf > 0),
  PRIMARY KEY (curve_id, limit_amount)
);

CREATE INDEX IF NOT EXISTS idx_fac_ilf_curve_family
  ON public.fac_ilf_curve (family_code, territory) WHERE active;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Family base rates — all empty
-- ═══════════════════════════════════════════════════════════════════════════

-- Liability: a basic-limit loss cost per unit of exposure. basis_unit says
-- what the unit is, because turnover, payroll and fee income are not
-- interchangeable and a rate quoted against the wrong one is silently wrong.
CREATE TABLE IF NOT EXISTS public.fac_liability_base_rate (
  rate_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_cob_id    uuid REFERENCES public.fac_class_of_business(fac_cob_id),
  territory     text NOT NULL DEFAULT 'WORLDWIDE',
  basis_unit    text NOT NULL,          -- TURNOVER | PAYROLL | FEE_INCOME | UNITS
  basis_divisor numeric(18,2) NOT NULL DEFAULT 1000000,  -- rate is per this much exposure
  basic_limit   numeric(18,2) NOT NULL,
  loss_cost_per_unit numeric(18,6) NOT NULL,
  hazard_band   text,
  source        text NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active        boolean NOT NULL DEFAULT true,
  CONSTRAINT fac_liability_base_rate_unit
    CHECK (basis_unit IN ('TURNOVER', 'PAYROLL', 'FEE_INCOME', 'UNITS'))
);

CREATE INDEX IF NOT EXISTS idx_fac_liability_base_rate_lookup
  ON public.fac_liability_base_rate (fac_cob_id, territory, basis_unit) WHERE active;

-- Cargo: a rate per mille of the values sent, by what is being sent, how,
-- and where. The maximum any-one-conveyance limit is the real exposure
-- control on a cargo account, and it lives on the section, not here.
CREATE TABLE IF NOT EXISTS public.fac_transit_base_rate (
  rate_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commodity     text NOT NULL,
  conveyance    text NOT NULL,          -- SEA | AIR | ROAD | RAIL | MULTIMODAL
  route_region  text NOT NULL DEFAULT 'WORLDWIDE',
  rate_pm       numeric(12,6) NOT NULL,
  packing_factor numeric(9,4),
  source        text NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active        boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_fac_transit_base_rate_lookup
  ON public.fac_transit_base_rate (commodity, conveyance, route_region) WHERE active;

-- Hull: a rate per mille of agreed value by vessel type and size, then
-- adjusted by the vessel's own characteristics.
CREATE TABLE IF NOT EXISTS public.fac_hull_base_rate (
  rate_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_type   text NOT NULL,
  tonnage_min   numeric(12,2) NOT NULL DEFAULT 0,
  tonnage_max   numeric(12,2),
  rate_pm       numeric(12,6) NOT NULL,
  source        text NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active        boolean NOT NULL DEFAULT true,
  CONSTRAINT fac_hull_base_rate_tonnage CHECK (tonnage_max IS NULL OR tonnage_max > tonnage_min)
);

-- Multiplicative adjustments applied to the hull base rate: age, class
-- society, flag, trading area, management, claims record. One table rather
-- than six columns, because which adjustments a carrier applies is its own
-- decision and this way adding one is a row, not a migration.
CREATE TABLE IF NOT EXISTS public.fac_hull_factor (
  factor_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_kind  text NOT NULL,   -- AGE | CLASS | FLAG | TRADING_AREA | MANAGEMENT | CLAIMS
  factor_key   text NOT NULL,   -- the value it matches, e.g. 'IACS' or '0-5'
  factor       numeric(9,4) NOT NULL CHECK (factor > 0),
  source       text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (factor_kind, factor_key)
);

-- War and strikes. A separate section on a separate rate, never a
-- percentage loading on hull — and dated, because these move in weeks.
CREATE TABLE IF NOT EXISTS public.fac_war_rate (
  war_rate_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region        text NOT NULL,
  basis         text NOT NULL DEFAULT 'ANNUAL',  -- ANNUAL | PER_TRANSIT
  rate_pm       numeric(12,6) NOT NULL,
  breach_ap_pm  numeric(12,6),     -- breach-of-warranty additional premium
  source        text NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active        boolean NOT NULL DEFAULT true,
  notes         text
);

CREATE INDEX IF NOT EXISTS idx_fac_war_rate_region
  ON public.fac_war_rate (region, effective_from DESC) WHERE active;
