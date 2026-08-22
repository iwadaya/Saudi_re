-- 140_fac_risk_geocode.sql
--
-- Coordinates for the insured address on a fac risk.
--
-- The address form now offers Google Places autocomplete (routes/facPlaces.js).
-- Picking a suggestion writes a normalised one-line address into the existing
-- insured_address column and the resolved point into the columns below, so the
-- risk carries a machine-readable location and not just prose.
--
-- place_id is kept so a stored address can be re-resolved later (Google's
-- formatting and geometry both drift) without re-typing it, and so a re-save
-- of an unchanged address is recognisable as the same place.
--
-- Nullable additions only: every existing row stays valid, a hand-typed address
-- with no pick simply leaves the three columns NULL, and nothing reads them yet.
-- fac_location already carries its own latitude/longitude/cresta_zone for the
-- per-site breakdown (migration 053) — this is the risk-header equivalent and
-- deliberately does not touch that table.

ALTER TABLE public.fac_risk
  ADD COLUMN IF NOT EXISTS insured_address_lat      numeric(10,7),
  ADD COLUMN IF NOT EXISTS insured_address_lng      numeric(10,7),
  ADD COLUMN IF NOT EXISTS insured_address_place_id text;

COMMENT ON COLUMN public.fac_risk.insured_address_lat IS
  'Latitude of insured_address, set when the address was chosen from Places autocomplete. NULL for hand-typed addresses.';
COMMENT ON COLUMN public.fac_risk.insured_address_lng IS
  'Longitude of insured_address, set when the address was chosen from Places autocomplete. NULL for hand-typed addresses.';
COMMENT ON COLUMN public.fac_risk.insured_address_place_id IS
  'Google Places id backing insured_address, for later re-resolution. NULL for hand-typed addresses.';
