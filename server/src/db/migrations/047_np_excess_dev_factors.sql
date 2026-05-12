-- 047_np_excess_dev_factors.sql
-- Adds NP_EXCESS triangle type + excess LDF factor table for NP experience rating

-- 1. Extend triangle_type enum with NP_EXCESS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.triangle_type'::regtype
      AND enumlabel = 'NP_EXCESS'
  ) THEN
    ALTER TYPE public.triangle_type ADD VALUE 'NP_EXCESS';
  END IF;
END $$;

-- 2. Ensure contract_triangle_cells accepts NP_EXCESS
--    (no change needed — uses the enum column `type` which is now extended)

-- 3. Contract NP excess LDF chosen factors table
--    Mirrors contract_dev_factor but specifically for the NP excess layer,
--    keyed on (contract_id, dev_month) for direct access by NpFinalPricing.
CREATE TABLE IF NOT EXISTS public.contract_np_excess_ldf (
  contract_id   uuid        NOT NULL REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  dev_month     integer     NOT NULL,
  chosen_source text        NULL,
  chosen_ldf    numeric     NULL,
  chosen_cdf    numeric     NULL,
  actual_ldf    numeric     NULL,
  actual_cdf    numeric     NULL,
  param_ldf     numeric     NULL,
  param_cdf     numeric     NULL,
  tail_factor   numeric     NOT NULL DEFAULT 1.0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, dev_month)
);

-- 4. Quote-level variant (mirrors contract table for quote mode)
CREATE TABLE IF NOT EXISTS public.quote_np_excess_ldf (
  quote_id      uuid        NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  dev_month     integer     NOT NULL,
  chosen_source text        NULL,
  chosen_ldf    numeric     NULL,
  chosen_cdf    numeric     NULL,
  actual_ldf    numeric     NULL,
  actual_cdf    numeric     NULL,
  param_ldf     numeric     NULL,
  param_cdf     numeric     NULL,
  tail_factor   numeric     NOT NULL DEFAULT 1.0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, dev_month)
);

-- 5. Index for fast lookup by contract
CREATE INDEX IF NOT EXISTS idx_contract_np_excess_ldf_contract
  ON public.contract_np_excess_ldf (contract_id);

CREATE INDEX IF NOT EXISTS idx_quote_np_excess_ldf_quote
  ON public.quote_np_excess_ldf (quote_id);
