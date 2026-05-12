-- Migration 010: Add contract_description to contract and quote tables
ALTER TABLE public.contract ADD COLUMN IF NOT EXISTS contract_description text;
ALTER TABLE public.quote ADD COLUMN IF NOT EXISTS contract_description text;
CREATE INDEX IF NOT EXISTS idx_contract_description ON public.contract (contract_description);
