-- Migration 030: add taxes_pct to contract_np_details and quote_np_details
-- Allows NP underwriters to record parafiscal taxes separately from brokerage

ALTER TABLE public.contract_np_details
  ADD COLUMN IF NOT EXISTS taxes_pct NUMERIC;

ALTER TABLE public.quote_np_details
  ADD COLUMN IF NOT EXISTS taxes_pct NUMERIC;
