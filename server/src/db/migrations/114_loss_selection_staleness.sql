-- 114_loss_selection_staleness.sql
-- Staleness tracking for the loss-selection snapshot: warns the UI that the
-- saved selection may need review when large/cat losses have been edited since.
--
-- loss_selection_saved_at — set to now() on the prop-details row whenever a
--   loss-selection snapshot is saved (see the snapshot PUT handlers). Nullable:
--   null means no selection has ever been saved (never stale).
-- contract_large_losses / contract_cat_losses .updated_at — these tables are
--   rewritten (DELETE + INSERT) on every save, so DEFAULT now() naturally
--   reflects the last edit without route changes. Existing rows are backfilled
--   from created_at. (Both tables are shared by treaty and quote via report_id.)

ALTER TABLE public.contract_prop_details
  ADD COLUMN IF NOT EXISTS loss_selection_saved_at timestamp with time zone DEFAULT NULL;
ALTER TABLE public.quote_prop_details
  ADD COLUMN IF NOT EXISTS loss_selection_saved_at timestamp with time zone DEFAULT NULL;

ALTER TABLE public.contract_large_losses
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
ALTER TABLE public.contract_cat_losses
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

UPDATE public.contract_large_losses SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE public.contract_cat_losses   SET updated_at = created_at WHERE updated_at IS NULL;
