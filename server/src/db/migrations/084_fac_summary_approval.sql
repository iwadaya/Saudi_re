-- 084_fac_summary_approval.sql
-- Summary screen captures three extra fields on fac_pricing (the
-- underwriter's proposed capacity %, the accepted rate, and a free-text
-- UW note) and one on fac_risk (the bound policy reference).
-- The bound_reference is generated server-side from a dedicated
-- sequence on bind; UNIQUE means a retry or replay never collides.
-- All columns nullable so a draft summary saves cleanly.

ALTER TABLE public.fac_pricing
  ADD COLUMN IF NOT EXISTS capacity_proposed_pct numeric(7,4),
  ADD COLUMN IF NOT EXISTS accepted_rate_pm      numeric(12,8),
  ADD COLUMN IF NOT EXISTS uw_note               text;

ALTER TABLE public.fac_risk
  ADD COLUMN IF NOT EXISTS bound_reference       text;

-- Add the UNIQUE constraint via a conditional create so re-runs after
-- the column already exists don't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fac_risk_bound_reference_key'
       AND conrelid = 'public.fac_risk'::regclass
  ) THEN
    ALTER TABLE public.fac_risk
      ADD CONSTRAINT fac_risk_bound_reference_key UNIQUE (bound_reference);
  END IF;
END
$$;

CREATE SEQUENCE IF NOT EXISTS public.fac_bound_reference_seq
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  CACHE 1;
