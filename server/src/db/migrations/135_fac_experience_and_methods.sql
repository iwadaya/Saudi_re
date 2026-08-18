-- 135_fac_experience_and_methods.sql
-- Facultative Phase 2: loss experience that reaches the price, per-method
-- pricing results, and a versioned exposure-curve library.
-- (Design doc §4.5 M3 + M5, findings F4 and F3.)
--
-- Part 1 — Experience. fac_loss_history has always collected FGU paid and
-- outstanding per year with a cause and mitigation notes, and none of it
-- ever entered a rate: the pricing screen had a free-text
-- `burning_cost_ratio` the underwriter filled in by hand (finding F4).
-- Burning cost needs three things the table did not carry — the loss
-- indexed to current values, the loss as-if the current structure, and a
-- development factor for claims still open — plus a denominator, which is
-- what fac_experience_basis is. Without the denominator there is no rate,
-- only a total; the Loss History screen says as much in a comment next to
-- the claim-ratio column it cannot fill.
--
-- Part 2 — Method results. One risk now produces several independent
-- estimates of the same loss cost. fac_pricing_method keeps every one of
-- them with the weight it was given and where that weight came from, so a
-- quote can be explained after the fact: not just what the rate was, but
-- which methods produced it, what they each said, and whether a human
-- overrode the mechanical blend.
--
-- Part 3 — Curves. Exposure rating allocates a ground-up loss cost to a
-- layer through an exposure curve. The curve is reference data, not code:
-- which curve applies to a given size band is an underwriting judgement,
-- and the curve sets a carrier is entitled to use are its own. The tables
-- hold tabulated curves; shared/fac can also generate one from published
-- MBBEFD parameters.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Loss experience
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.fac_loss_history
  ADD COLUMN IF NOT EXISTS section_id          uuid
    REFERENCES public.fac_risk_section(section_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS currency_id         uuid REFERENCES public.currency(currency_id),
  ADD COLUMN IF NOT EXISTS indexed_incurred    numeric(18,2),
  ADD COLUMN IF NOT EXISTS as_if_incurred      numeric(18,2),
  ADD COLUMN IF NOT EXISTS development_factor  numeric(9,4),
  ADD COLUMN IF NOT EXISTS exclude_from_rating boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS exclusion_reason    text;

COMMENT ON COLUMN public.fac_loss_history.indexed_incurred IS
  'FGU incurred trended to current values. NULL = derive from the risk-level index.';
COMMENT ON COLUMN public.fac_loss_history.as_if_incurred IS
  'Indexed incurred restated onto the current structure (SI, deductible, limit).';
COMMENT ON COLUMN public.fac_loss_history.development_factor IS
  'Applied to open claims only. NULL = use the risk-level default for the year.';
COMMENT ON COLUMN public.fac_loss_history.exclude_from_rating IS
  'Kept in the history, kept out of the burning cost. Requires a reason.';

-- The denominator. One row per exposure year: what was on risk, and the
-- rate movement that year so the premiums can be brought on-level with
-- shared/onLevel.js — the same arithmetic the treaty side already uses.
CREATE TABLE IF NOT EXISTS public.fac_experience_basis (
  fac_risk_id     uuid NOT NULL
                    REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  loss_year       integer NOT NULL,
  exposure_base   numeric(18,2),
  exposure_unit   text,
  premium         numeric(18,2),
  rate_change_pct numeric(9,4),
  claim_count     integer,
  notes           text,
  updated_at      timestamptz DEFAULT now(),
  PRIMARY KEY (fac_risk_id, loss_year)
);

CREATE INDEX IF NOT EXISTS idx_fac_loss_history_year
  ON public.fac_loss_history (fac_risk_id, loss_year);

-- Risk-level experience assumptions. One row per risk; the per-loss columns
-- above override it where an underwriter has restated an individual claim.
ALTER TABLE public.fac_risk
  ADD COLUMN IF NOT EXISTS severity_trend_pct    numeric(9,4),
  ADD COLUMN IF NOT EXISTS experience_years      integer,
  ADD COLUMN IF NOT EXISTS experience_notes      text;

COMMENT ON COLUMN public.fac_risk.severity_trend_pct IS
  'Annual claims-inflation assumption used to index historic losses to current values.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Per-method pricing results
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_pricing_method (
  method_row_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id          uuid NOT NULL
                         REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  section_id           uuid REFERENCES public.fac_risk_section(section_id) ON DELETE CASCADE,
  method_code          text NOT NULL,
  available            boolean NOT NULL DEFAULT true,
  unavailable_reason   text,
  loss_cost            numeric(18,2),
  rate_pm              numeric(14,8),
  weight               numeric(7,4),
  weight_source        text,          -- MECHANICAL | OVERRIDE | EXCLUDED
  override_reason_code text,
  credibility_z        numeric(7,4),
  diagnostics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz DEFAULT now(),
  CONSTRAINT fac_pricing_method_unique UNIQUE (fac_risk_id, section_id, method_code)
);

CREATE INDEX IF NOT EXISTS idx_fac_pricing_method_risk
  ON public.fac_pricing_method (fac_risk_id);

-- The blend the methods above were combined into, and the technical build-up
-- that followed. Kept beside fac_pricing (which stays the signed-off row) so
-- the intermediate figures are recoverable without re-running the engine.
ALTER TABLE public.fac_pricing
  ADD COLUMN IF NOT EXISTS blended_loss_cost_pm numeric(14,8),
  ADD COLUMN IF NOT EXISTS cat_load_pm          numeric(14,8),
  ADD COLUMN IF NOT EXISTS risk_load_pm         numeric(14,8),
  ADD COLUMN IF NOT EXISTS internal_expense_pct numeric(7,4),
  ADD COLUMN IF NOT EXISTS blend_weights        jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS blend_override_reason text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Exposure-curve library
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_exposure_curve (
  curve_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curve_code     text NOT NULL UNIQUE,
  curve_name     text NOT NULL,
  curve_set      text,          -- e.g. the family or publication a curve belongs to
  source         text NOT NULL, -- where it came from; required, so no curve is anonymous
  kind           text NOT NULL DEFAULT 'TABULATED',  -- TABULATED | MBBEFD
  params         jsonb DEFAULT '{}'::jsonb,          -- {b, g} for MBBEFD
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  active         boolean NOT NULL DEFAULT true,
  notes          text,
  created_at     timestamptz DEFAULT now(),
  CONSTRAINT fac_exposure_curve_kind CHECK (kind IN ('TABULATED', 'MBBEFD'))
);

-- Tabulated points. x is the damage ratio (loss / MPL), y is G(x) — the
-- share of the ground-up expected loss falling at or below x. Both are
-- bounded, and G must run from 0 to 1; the checks stop a malformed curve
-- from silently producing a negative layer cost.
CREATE TABLE IF NOT EXISTS public.fac_exposure_curve_point (
  curve_id uuid NOT NULL
             REFERENCES public.fac_exposure_curve(curve_id) ON DELETE CASCADE,
  x        numeric(9,6) NOT NULL CHECK (x >= 0 AND x <= 1),
  y        numeric(9,6) NOT NULL CHECK (y >= 0 AND y <= 1),
  PRIMARY KEY (curve_id, x)
);

-- Which curve applies to which size band, per family. Bands are on the
-- exposure base (sum insured for property), open-ended at the top.
CREATE TABLE IF NOT EXISTS public.fac_curve_band (
  band_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_code   text NOT NULL,
  min_exposure  numeric(18,2) NOT NULL DEFAULT 0,
  max_exposure  numeric(18,2),          -- NULL = no upper bound
  curve_id      uuid NOT NULL REFERENCES public.fac_exposure_curve(curve_id),
  sort_order    integer DEFAULT 0,
  CONSTRAINT fac_curve_band_range CHECK (max_exposure IS NULL OR max_exposure > min_exposure)
);

CREATE INDEX IF NOT EXISTS idx_fac_curve_band_family
  ON public.fac_curve_band (family_code, min_exposure);

-- The only curve shipped as data: G(x) = x, the uniform destruction rate.
-- It is what exposure rating reduces to when nothing is known about the
-- size-of-loss distribution, and it is the neutral answer — it makes no
-- claim about severity. Every other curve encodes a view of severity, so
-- it belongs to whoever holds that view; curve sets are loaded, not
-- invented here. See docs/facultative-pricing-design.md §8.
INSERT INTO public.fac_exposure_curve (curve_code, curve_name, curve_set, source, kind, notes)
VALUES (
  'LINEAR',
  'Linear (uniform destruction rate)',
  'BASELINE',
  'G(x) = x. The definitional baseline, not a market curve.',
  'TABULATED',
  'Assumes loss is uniformly distributed over the maximum possible loss. Use only '
  || 'as a reference point or where no curve set has been licensed — it understates '
  || 'the cost of low layers on risks whose losses cluster small.'
)
ON CONFLICT (curve_code) DO NOTHING;

INSERT INTO public.fac_exposure_curve_point (curve_id, x, y)
SELECT c.curve_id, g.x, g.x
FROM public.fac_exposure_curve c
CROSS JOIN (SELECT generate_series(0, 100)::numeric / 100 AS x) g
WHERE c.curve_code = 'LINEAR'
ON CONFLICT DO NOTHING;
