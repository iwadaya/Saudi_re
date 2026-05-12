-- 012_loss_audit_and_snapshot_tables.sql
-- Creates missing snapshot tables, adds loss_id for audit traceability,
-- adds loadings/inflation persistence to selection, and ensures
-- distribution fit parameters are captured for audit.

BEGIN;

-- ═══════════════════════════════════════════════════════════════
-- 1. Ensure loss tables have serial loss_id for audit traceability
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.contract_large_losses
  ADD COLUMN IF NOT EXISTS loss_id uuid DEFAULT gen_random_uuid();

ALTER TABLE public.contract_cat_losses
  ADD COLUMN IF NOT EXISTS loss_id uuid DEFAULT gen_random_uuid();

-- Backfill any rows that got null loss_id
UPDATE public.contract_large_losses SET loss_id = gen_random_uuid() WHERE loss_id IS NULL;
UPDATE public.contract_cat_losses   SET loss_id = gen_random_uuid() WHERE loss_id IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- 2. Create snapshot tables (base CREATE — migration 009 ALTERs these)
--    Using IF NOT EXISTS so safe to run on existing DBs
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.contract_loss_selection_snapshot (
  snapshot_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id          uuid NOT NULL,
  loss_type            text NOT NULL CHECK (loss_type IN ('LARGE','CAT')),

  -- Inflation audit trail
  inflation_mode       text,          -- 'table' | 'average' | 'manual' | 'growth'
  inflation_index      text,          -- e.g. 'CPI_SA' or country name
  inflation_rate_pct   numeric(8,4),  -- the effective rate used (manual or average)
  inflation_base_year  integer,
  inflation_to_year    integer,

  -- Selection audit
  threshold            numeric(18,2), -- the incurred threshold used to auto-select
  selected_count       integer,
  global_factor        numeric(10,6),

  -- Additional loadings (JSONB array of {name, pct})
  loadings             jsonb,         -- [{name:'IBNR', pct:5}, {name:'Trend', pct:2}]
  total_loading_pct    numeric(8,4),

  -- Distribution fit parameters — all four distributions
  distribution_fits    jsonb,         -- [{key,params,ks:{ks,pValue},paramStr,n}, ...]

  -- The user's chosen distribution
  active_distribution  text,          -- 'pareto' | 'lognormal' | 'exponential' | 'weibull'

  -- Pareto parameters (quick-access for pricing)
  pareto_xm            numeric(18,2),
  pareto_alpha         numeric(12,6),
  pareto_limit         numeric(18,2),
  observation_years    numeric(6,1),

  -- Return period curve + key points
  return_period_curve      jsonb,     -- {activeDist, xm, limit, yearsOvr, points:[{rp,loss}]}
  return_period_key_points jsonb,     -- {rp10, rp50, rp100, rp250}

  -- Integrity
  assumptions_hash     text,
  updated_at           timestamptz DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_loss_selection_snapshot_contract_type_created
  ON public.contract_loss_selection_snapshot (contract_id, loss_type, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- 3. Snapshot items (individual selected losses frozen at point-in-time)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.contract_loss_selection_snapshot_item (
  item_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id          uuid NOT NULL REFERENCES public.contract_loss_selection_snapshot(snapshot_id) ON DELETE CASCADE,
  source_loss_id       uuid,          -- FK back to contract_large_losses.loss_id or contract_cat_losses.loss_id
  uw_year              integer,
  insured_name         text,
  loss_name            text,
  date_of_loss         date,
  class_of_business    text,
  paid                 numeric(18,2) DEFAULT 0,
  os                   numeric(18,2) DEFAULT 0,
  incurred             numeric(18,2) DEFAULT 0,
  inflation_factor     numeric(10,6) DEFAULT 1,
  inflated_incurred    numeric(18,2),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_snapshot_item_snapshot
  ON public.contract_loss_selection_snapshot_item (snapshot_id);

-- ═══════════════════════════════════════════════════════════════
-- 4. Add new columns to snapshot if they don't exist yet
--    (safe for DBs that already ran 009 but not this migration)
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.contract_loss_selection_snapshot
  ADD COLUMN IF NOT EXISTS inflation_rate_pct   numeric(8,4),
  ADD COLUMN IF NOT EXISTS threshold            numeric(18,2),
  ADD COLUMN IF NOT EXISTS loadings             jsonb,
  ADD COLUMN IF NOT EXISTS total_loading_pct    numeric(8,4),
  ADD COLUMN IF NOT EXISTS distribution_fits    jsonb,
  ADD COLUMN IF NOT EXISTS active_distribution  text,
  ADD COLUMN IF NOT EXISTS pareto_xm            numeric(18,2),
  ADD COLUMN IF NOT EXISTS pareto_alpha         numeric(12,6),
  ADD COLUMN IF NOT EXISTS pareto_limit         numeric(18,2),
  ADD COLUMN IF NOT EXISTS observation_years    numeric(6,1);

-- Trigger for updated_at
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    BEGIN
      CREATE TRIGGER trg_loss_snapshot_updated
      BEFORE UPDATE ON public.contract_loss_selection_snapshot
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

COMMIT;
