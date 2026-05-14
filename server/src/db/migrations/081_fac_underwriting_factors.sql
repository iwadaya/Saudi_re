-- 081_fac_underwriting_factors.sql
-- Persist the underwriter's 18-factor selections per FAC risk. We keep
-- selections in a JSONB blob (factor_code → option_label) rather than a
-- normalised join table — the values are looked up against the
-- fac_factor_master / fac_factor_option reference tables on every save,
-- so a relational FK buys us nothing while a JSONB makes the wire shape
-- match the engine input ({CONSTRUCTION:"Class A …", AGE_OF_RISK:"…"}).

CREATE TABLE IF NOT EXISTS public.fac_underwriting_factors (
  fac_risk_id  uuid PRIMARY KEY REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  selections   jsonb NOT NULL DEFAULT '{}',
  notes        text,
  updated_at   timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fac_underwriting_factors_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fac_uw_factors_touch ON public.fac_underwriting_factors;
CREATE TRIGGER trg_fac_uw_factors_touch
  BEFORE UPDATE ON public.fac_underwriting_factors
  FOR EACH ROW EXECUTE FUNCTION public.fac_underwriting_factors_touch();
