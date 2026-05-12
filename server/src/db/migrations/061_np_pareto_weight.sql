-- Migration 061: Add pareto_weight_pct to NP pricing inputs/outputs (treaty + quote)
--
-- The NP layer pricing screen used to blend Pure Burn, Pareto, and Exposure
-- with only TWO weights (burn, exposure), forcing wBurn = 100 - wExp and
-- summing burn + pareto inside the burn weight. That double-counted the
-- experience signal. Switch to a 3-way blend: every component has its own
-- weight, normalised by Σ weights at calc time. This migration adds the new
-- column on the four tables that store the weights.
--
-- Default 0 for backwards compatibility: existing rows continue to use only
-- burn + exposure until the user explicitly assigns a Pareto weight.

ALTER TABLE public.contract_np_pricing_inputs
  ADD COLUMN IF NOT EXISTS pareto_weight_pct numeric DEFAULT 0;

ALTER TABLE public.contract_np_pricing_outputs
  ADD COLUMN IF NOT EXISTS pareto_weight_pct numeric DEFAULT 0;

ALTER TABLE public.quote_np_pricing_inputs
  ADD COLUMN IF NOT EXISTS pareto_weight_pct numeric(10,4) DEFAULT 0;

ALTER TABLE public.quote_np_pricing_outputs
  ADD COLUMN IF NOT EXISTS pareto_weight_pct numeric(10,4) DEFAULT 0;
