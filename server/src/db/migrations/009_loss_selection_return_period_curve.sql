-- 009_loss_selection_return_period_curve.sql
-- Persist return period curve + key points from Pareto screens so Pricing can consume without refitting

ALTER TABLE public.contract_loss_selection_snapshot
  ADD COLUMN IF NOT EXISTS return_period_curve jsonb,
  ADD COLUMN IF NOT EXISTS return_period_key_points jsonb,
  ADD COLUMN IF NOT EXISTS assumptions_hash text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Keep updated_at current on updates (if set_updated_at() exists, reuse it)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    BEGIN
      CREATE TRIGGER trg_contract_loss_selection_snapshot_updated
      BEFORE UPDATE ON public.contract_loss_selection_snapshot
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    EXCEPTION WHEN duplicate_object THEN
      -- ignore
      NULL;
    END;
  END IF;
END $$;

-- Helpful lookup index for latest snapshot per contract/type
CREATE INDEX IF NOT EXISTS ix_loss_selection_snapshot_contract_type_created
  ON public.contract_loss_selection_snapshot (contract_id, loss_type, created_at DESC);
