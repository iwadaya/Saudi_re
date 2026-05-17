-- 101_np_stop_loss_pricing.sql
-- Persistence for the Stop Loss / Aggregate XL pricing screen.
--
-- Inputs are heterogeneous (attachment basis, frequency/severity
-- params, weights, MC config, a yearly-aggregate table) and the engine
-- evolves screen-side, so we store both inputs and computed outputs as
-- JSONB rather than normalised columns. One row per contract/quote;
-- pricing inputs are unique per treaty.

CREATE TABLE IF NOT EXISTS public.contract_np_stop_loss_pricing (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL UNIQUE REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  inputs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs     jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_np_stop_loss_pricing_contract
  ON public.contract_np_stop_loss_pricing (contract_id);

CREATE TABLE IF NOT EXISTS public.quote_np_stop_loss_pricing (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    uuid NOT NULL UNIQUE REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  inputs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs     jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_np_stop_loss_pricing_quote
  ON public.quote_np_stop_loss_pricing (quote_id);
