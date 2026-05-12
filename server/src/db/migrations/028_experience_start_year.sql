-- 028: Add experience_start_year to prop and NP details tables
-- This separates "UW year" (= year of inception) from "experience start year"
-- (= first year of experience data: drives triangle columns for PROP,
--  EGNPI/inflation rows for NP).

ALTER TABLE public.contract_prop_details
  ADD COLUMN IF NOT EXISTS experience_start_year INT;

ALTER TABLE public.quote_prop_details
  ADD COLUMN IF NOT EXISTS experience_start_year INT;

ALTER TABLE public.contract_np_details
  ADD COLUMN IF NOT EXISTS experience_start_year INT;

ALTER TABLE public.quote_np_details
  ADD COLUMN IF NOT EXISTS experience_start_year INT;
