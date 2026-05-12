-- 013_seed_country_inflation.sql
-- Create ref_country_inflation if it doesn't exist, then seed
-- CPI inflation rates for Saudi Arabia, UAE, and United Kingdom (2000–2026).
-- Sources: World Bank, IMF WEO, national statistics agencies.
-- 2025–2026 are IMF projections.

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. Ensure the table exists
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ref_country_inflation (
  country_id   uuid NOT NULL,
  uw_year      integer NOT NULL,
  inflation_pct numeric(8,3) NOT NULL DEFAULT 0,
  source       text DEFAULT 'IMF_WEO',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country_id, uw_year)
);

-- Add source column if table already existed without it
ALTER TABLE public.ref_country_inflation
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'IMF_WEO';

-- ═══════════════════════════════════════════════════════════════
-- 2. Seed inflation data
--    Uses DO block to look up country_id dynamically by country_code.
--    ON CONFLICT upserts so this is safe to re-run.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_sa uuid;
  v_ae uuid;
  v_gb uuid;
BEGIN
  SELECT country_id INTO v_sa FROM public.country WHERE country_code = 'SA' LIMIT 1;
  SELECT country_id INTO v_ae FROM public.country WHERE country_code = 'AE' LIMIT 1;
  SELECT country_id INTO v_gb FROM public.country WHERE country_code = 'GB' LIMIT 1;

  -- ───────────────────────────────────────────
  -- SAUDI ARABIA (SA) — CPI Annual %
  -- ───────────────────────────────────────────
  IF v_sa IS NOT NULL THEN
    INSERT INTO public.ref_country_inflation (country_id, uw_year, inflation_pct, source) VALUES
      (v_sa, 2000, -1.1, 'World Bank'),
      (v_sa, 2001,  -0.8, 'World Bank'),
      (v_sa, 2002,   0.2, 'World Bank'),
      (v_sa, 2003,   0.6, 'World Bank'),
      (v_sa, 2004,   0.4, 'World Bank'),
      (v_sa, 2005,   0.6, 'World Bank'),
      (v_sa, 2006,   2.3, 'World Bank'),
      (v_sa, 2007,   4.1, 'World Bank'),
      (v_sa, 2008,   9.9, 'World Bank'),
      (v_sa, 2009,   5.1, 'World Bank'),
      (v_sa, 2010,   3.8, 'World Bank'),
      (v_sa, 2011,   3.7, 'World Bank'),
      (v_sa, 2012,   2.9, 'World Bank'),
      (v_sa, 2013,   3.5, 'World Bank'),
      (v_sa, 2014,   2.7, 'World Bank'),
      (v_sa, 2015,   2.2, 'World Bank'),
      (v_sa, 2016,   3.5, 'World Bank'),
      (v_sa, 2017,  -0.9, 'World Bank'),
      (v_sa, 2018,   2.5, 'World Bank'),
      (v_sa, 2019,  -2.1, 'World Bank'),
      (v_sa, 2020,   3.4, 'World Bank'),
      (v_sa, 2021,   3.1, 'World Bank'),
      (v_sa, 2022,   2.5, 'IMF WEO'),
      (v_sa, 2023,   2.3, 'IMF WEO'),
      (v_sa, 2024,   1.7, 'IMF WEO'),
      (v_sa, 2025,   2.0, 'IMF WEO Proj'),
      (v_sa, 2026,   2.0, 'IMF WEO Proj')
    ON CONFLICT (country_id, uw_year) DO UPDATE SET
      inflation_pct = EXCLUDED.inflation_pct,
      source = EXCLUDED.source;
  END IF;

  -- ───────────────────────────────────────────
  -- UAE (AE) — CPI Annual %
  -- ───────────────────────────────────────────
  IF v_ae IS NOT NULL THEN
    INSERT INTO public.ref_country_inflation (country_id, uw_year, inflation_pct, source) VALUES
      (v_ae, 2000,  1.4, 'World Bank'),
      (v_ae, 2001,  2.8, 'World Bank'),
      (v_ae, 2002,  2.9, 'World Bank'),
      (v_ae, 2003,  3.1, 'World Bank'),
      (v_ae, 2004,  5.0, 'World Bank'),
      (v_ae, 2005,  6.2, 'World Bank'),
      (v_ae, 2006,  9.3, 'World Bank'),
      (v_ae, 2007, 11.1, 'World Bank'),
      (v_ae, 2008, 12.3, 'World Bank'),
      (v_ae, 2009,  1.6, 'World Bank'),
      (v_ae, 2010,  0.9, 'World Bank'),
      (v_ae, 2011,  0.9, 'World Bank'),
      (v_ae, 2012,  0.7, 'World Bank'),
      (v_ae, 2013,  1.1, 'World Bank'),
      (v_ae, 2014,  2.3, 'World Bank'),
      (v_ae, 2015,  4.1, 'World Bank'),
      (v_ae, 2016,  1.6, 'World Bank'),
      (v_ae, 2017,  2.0, 'World Bank'),
      (v_ae, 2018,  3.1, 'World Bank'),
      (v_ae, 2019, -1.9, 'World Bank'),
      (v_ae, 2020, -2.1, 'World Bank'),
      (v_ae, 2021,  0.2, 'World Bank'),
      (v_ae, 2022,  4.8, 'IMF WEO'),
      (v_ae, 2023,  1.6, 'IMF WEO'),
      (v_ae, 2024,  2.1, 'IMF WEO'),
      (v_ae, 2025,  2.3, 'IMF WEO Proj'),
      (v_ae, 2026,  2.2, 'IMF WEO Proj')
    ON CONFLICT (country_id, uw_year) DO UPDATE SET
      inflation_pct = EXCLUDED.inflation_pct,
      source = EXCLUDED.source;
  END IF;

  -- ───────────────────────────────────────────
  -- UNITED KINGDOM (GB) — CPI Annual %
  -- ───────────────────────────────────────────
  IF v_gb IS NOT NULL THEN
    INSERT INTO public.ref_country_inflation (country_id, uw_year, inflation_pct, source) VALUES
      (v_gb, 2000,  0.8, 'ONS'),
      (v_gb, 2001,  1.2, 'ONS'),
      (v_gb, 2002,  1.3, 'ONS'),
      (v_gb, 2003,  1.4, 'ONS'),
      (v_gb, 2004,  1.3, 'ONS'),
      (v_gb, 2005,  2.1, 'ONS'),
      (v_gb, 2006,  2.3, 'ONS'),
      (v_gb, 2007,  2.3, 'ONS'),
      (v_gb, 2008,  3.6, 'ONS'),
      (v_gb, 2009,  2.2, 'ONS'),
      (v_gb, 2010,  3.3, 'ONS'),
      (v_gb, 2011,  4.5, 'ONS'),
      (v_gb, 2012,  2.8, 'ONS'),
      (v_gb, 2013,  2.6, 'ONS'),
      (v_gb, 2014,  1.5, 'ONS'),
      (v_gb, 2015,  0.0, 'ONS'),
      (v_gb, 2016,  0.7, 'ONS'),
      (v_gb, 2017,  2.7, 'ONS'),
      (v_gb, 2018,  2.5, 'ONS'),
      (v_gb, 2019,  1.8, 'ONS'),
      (v_gb, 2020,  0.9, 'ONS'),
      (v_gb, 2021,  2.6, 'ONS'),
      (v_gb, 2022, 10.1, 'ONS'),
      (v_gb, 2023,  7.3, 'ONS'),
      (v_gb, 2024,  2.5, 'IMF WEO'),
      (v_gb, 2025,  2.2, 'IMF WEO Proj'),
      (v_gb, 2026,  2.0, 'IMF WEO Proj')
    ON CONFLICT (country_id, uw_year) DO UPDATE SET
      inflation_pct = EXCLUDED.inflation_pct,
      source = EXCLUDED.source;
  END IF;

END $$;

-- ═══════════════════════════════════════════════════════════════
-- 3. Useful index for lookups
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS ix_ref_inflation_country_year
  ON public.ref_country_inflation (country_id, uw_year);

COMMIT;
