-- 076_quote_np_historical_performance.sql
-- Quote-mode counterpart for NP historical performance.

CREATE TABLE IF NOT EXISTS public.quote_np_historical_performance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
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
  UNIQUE (quote_id, uw_year)
);

CREATE INDEX IF NOT EXISTS idx_quote_np_hist_perf_quote
  ON public.quote_np_historical_performance (quote_id, uw_year);
