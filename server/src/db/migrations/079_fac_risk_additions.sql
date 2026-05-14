-- 079_fac_risk_additions.sql
-- Extend fac_risk with the fields the pricing template captures on its
-- Summary Sheet top half (cedant region, renewal/new, expiring ref,
-- risk country/zone, multi-location & multi-occupancy flags, top
-- location address, occupancy + denormalised hazard / risk / frequency
-- fields, hazard grade override).
-- All columns are nullable additions; no existing columns are touched.

ALTER TABLE public.fac_risk
  ADD COLUMN IF NOT EXISTS cedant_region              text,
  ADD COLUMN IF NOT EXISTS renewal_or_new             text,
  ADD COLUMN IF NOT EXISTS expiring_reference         text,
  ADD COLUMN IF NOT EXISTS risk_country_zone          text,
  ADD COLUMN IF NOT EXISTS multi_location_flag        boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS multi_occupancy_flag       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS risk_location_top_address  text,
  ADD COLUMN IF NOT EXISTS occupancy_code             integer
    REFERENCES public.fac_occupancy_master(occupancy_code),
  ADD COLUMN IF NOT EXISTS occupancy_name             text,
  ADD COLUMN IF NOT EXISTS hazard_grade_override      integer
    CHECK (hazard_grade_override BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS hazard_category            text,
  ADD COLUMN IF NOT EXISTS risk_category              integer,
  ADD COLUMN IF NOT EXISTS frequency_category         integer;
