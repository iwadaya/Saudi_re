-- 096_axco_market_intelligence.sql
-- Wire Axco Insurance Intelligence as an authoritative data source
-- for the market intelligence generator.
--
-- Two cheap reference-data columns let the route translate our
-- country_id / class_of_business_id into Axco's own taxonomy. They
-- stay nullable — when unset, the route falls back to the existing
-- web-search-only path, no error.
--
-- The axco_snapshot column on market_intelligence_report captures
-- the exact payload returned by Axco at generation time so we can
-- audit what the model was given and reproduce the report later.

ALTER TABLE public.country
  ADD COLUMN IF NOT EXISTS axco_country_code text;

ALTER TABLE public.class_of_business
  ADD COLUMN IF NOT EXISTS axco_class_code text;

ALTER TABLE public.market_intelligence_report
  ADD COLUMN IF NOT EXISTS axco_snapshot jsonb;

-- Partial index on country.axco_country_code (only when populated)
-- so the lookup the route runs at every call stays O(1).
CREATE INDEX IF NOT EXISTS idx_country_axco_code
  ON public.country (axco_country_code)
  WHERE axco_country_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cob_axco_code
  ON public.class_of_business (axco_class_code)
  WHERE axco_class_code IS NOT NULL;
