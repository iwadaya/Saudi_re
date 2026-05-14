-- 080_fac_location_additions.sql
-- Extend fac_location with the columns the pricing template's Sum
-- Insured sheet captures: MD + BI in original currency, PML %, FX rate,
-- and the carrier's signed share split by MD / BI.
-- pd_si / bi_si stay as the SAR amounts (already on the table); the UI
-- recomputes them on save from original_pd_si × fx_to_sar.
-- All columns are nullable.

ALTER TABLE public.fac_location
  ADD COLUMN IF NOT EXISTS occupancy_code        integer
    REFERENCES public.fac_occupancy_master(occupancy_code),
  ADD COLUMN IF NOT EXISTS pd_pml_pct            numeric(7,4),
  ADD COLUMN IF NOT EXISTS bi_pml_pct            numeric(7,4),
  ADD COLUMN IF NOT EXISTS original_ccy          text,
  ADD COLUMN IF NOT EXISTS original_pd_si        numeric(18,2),
  ADD COLUMN IF NOT EXISTS original_bi_si        numeric(18,2),
  ADD COLUMN IF NOT EXISTS fx_to_sar             numeric(18,8),
  ADD COLUMN IF NOT EXISTS carrier_pd_share_pct  numeric(7,4),
  ADD COLUMN IF NOT EXISTS carrier_bi_share_pct  numeric(7,4);
