-- Migration 033: Persist actuarial_margin, actual_margin, written_line_pct to relational tables
-- These were only computed live in the UI; cedant summary needs them as durable columns.
-- Safe: all IF NOT EXISTS / ON CONFLICT guards.

-- 1. contract_pricing_outputs: add margin columns
ALTER TABLE public.contract_pricing_outputs
  ADD COLUMN IF NOT EXISTS actuarial_margin  numeric(12,8),
  ADD COLUMN IF NOT EXISTS actual_margin     numeric(12,8);

-- 2. quote_offer: add signed_line_pct column (written already exists)
ALTER TABLE public.quote_offer
  ADD COLUMN IF NOT EXISTS signed_line_pct   numeric(10,6);

-- 3. Indexes for cedant summary JOIN performance
CREATE INDEX IF NOT EXISTS idx_contract_pricing_outputs_contract
  ON public.contract_pricing_outputs (contract_id);

CREATE INDEX IF NOT EXISTS idx_contract_offer_contract
  ON public.contract_offer (contract_id);

CREATE INDEX IF NOT EXISTS idx_quote_offer_quote
  ON public.quote_offer (quote_id);

CREATE INDEX IF NOT EXISTS idx_contract_cedant
  ON public.contract (cedant_id, status);

CREATE INDEX IF NOT EXISTS idx_quote_cedant
  ON public.quote (cedant_id, status);
