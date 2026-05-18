-- 102_np_egnpi_year_rate_change.sql
-- Per-UW-year rate change for on-level premium adjustment.
--
-- The Stop Loss Pricing burning-cost calculation needs historical
-- premiums adjusted to current rate level so loss ratios reflect
-- today's pricing instead of a mix of vintages. We store one
-- `rate_change_pct` per UW year (the rate change *applied* that year,
-- e.g. +5% means premium for that year sits 5% above the prior year's
-- rate level). The on-level factor for year y =
--     Π over i > y of (1 + r_i / 100)
-- and adjusted_premium(y) = egnpi(y) × on_level_factor(y).
--
-- Column is nullable so existing rows stay valid; a missing value is
-- treated as 0% (no change) by the client.

DO $$ BEGIN IF NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='contract_np_egnpi_year' AND column_name='rate_change_pct'
) THEN
  ALTER TABLE public.contract_np_egnpi_year
    ADD COLUMN rate_change_pct numeric(8,4) DEFAULT NULL;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='quote_np_egnpi_year' AND column_name='rate_change_pct'
) THEN
  ALTER TABLE public.quote_np_egnpi_year
    ADD COLUMN rate_change_pct numeric(8,4) DEFAULT NULL;
END IF; END $$;
