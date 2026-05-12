-- Migration 023: Add est_gnpi and expiring_number_of_layers to quote_np_details
-- These were only stored in JSONB terms; now promoted to relational columns for reliable rehydration.

ALTER TABLE public.quote_np_details
  ADD COLUMN IF NOT EXISTS est_gnpi               numeric(18,2),
  ADD COLUMN IF NOT EXISTS expiring_number_of_layers integer;
