-- 054_np_historical_performance.sql
-- Per-UW-year performance data for NP treaty historical analysis.

CREATE TABLE IF NOT EXISTS public.contract_np_historical_performance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    uuid NOT NULL REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  uw_year        integer NOT NULL,
  premiums       numeric(18,2) DEFAULT NULL,
  claims         numeric(18,2) DEFAULT NULL,
  egnpi          numeric(18,2) DEFAULT NULL,
  result         numeric(18,2) DEFAULT NULL,
  loss_ratio     numeric(12,6) DEFAULT NULL,
  expense_ratio  numeric(12,6) DEFAULT NULL,
  combined_ratio numeric(12,6) DEFAULT NULL,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (contract_id, uw_year)
);

CREATE INDEX IF NOT EXISTS idx_np_hist_perf_contract
  ON public.contract_np_historical_performance (contract_id, uw_year);
