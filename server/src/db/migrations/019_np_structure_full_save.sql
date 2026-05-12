-- Migration 019: NP Structure full persistence
-- Safe to run on live DB (all IF NOT EXISTS / ON CONFLICT guards).

-- quote_np_layers already has all columns from the dump, but add peril_scope default guard
ALTER TABLE public.quote_np_layers
  ALTER COLUMN peril_scope SET DEFAULT 'BOTH';

-- Ensure contract_underwriting_limit has updated_at (for ON CONFLICT ... updated_at=now())
ALTER TABLE public.contract_underwriting_limit
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Ensure quote_underwriting_limit has updated_at
ALTER TABLE public.quote_underwriting_limit
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Index for fast COB-layer junction lookups (used by loss screens)
CREATE INDEX IF NOT EXISTS idx_np_layer_cob_lookup
  ON public.contract_np_layer_class_of_business (layer_id, class_of_business_id);

-- Index to quickly find all layers for a contract with their COBs (join path for loss engine)
CREATE INDEX IF NOT EXISTS idx_np_layers_cob_contract
  ON public.contract_np_layers (contract_id, layer_number);

