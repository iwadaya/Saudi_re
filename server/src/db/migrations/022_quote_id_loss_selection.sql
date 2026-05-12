-- 022_quote_id_loss_selection.sql
-- Allow loss selection snapshots to be associated with a quote (in addition to a contract)
-- Makes contract_id nullable and adds quote_id FK

ALTER TABLE public.contract_loss_selection_snapshot
  ALTER COLUMN contract_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quote(quote_id) ON DELETE CASCADE;

-- Ensure at least one of contract_id or quote_id is set
ALTER TABLE public.contract_loss_selection_snapshot
  DROP CONSTRAINT IF EXISTS chk_loss_sel_snap_owner,
  ADD CONSTRAINT chk_loss_sel_snap_owner CHECK (
    (contract_id IS NOT NULL) OR (quote_id IS NOT NULL)
  );

-- Index for quote-based lookups
CREATE INDEX IF NOT EXISTS idx_loss_sel_snap_quote_id
  ON public.contract_loss_selection_snapshot (quote_id, loss_type, created_at DESC);
