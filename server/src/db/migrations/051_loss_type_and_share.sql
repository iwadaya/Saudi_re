-- 051_loss_type_and_share.sql
-- Add loss_type (REPORTED/PROVISIONAL/CASH_CALL) and our_share_pct to loss tables

ALTER TABLE public.contract_large_losses
  ADD COLUMN IF NOT EXISTS loss_type    text    DEFAULT 'REPORTED',
  ADD COLUMN IF NOT EXISTS our_share_pct numeric(6,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gross_amount  numeric(18,2) DEFAULT NULL;

ALTER TABLE public.contract_cat_losses
  ADD COLUMN IF NOT EXISTS loss_type    text    DEFAULT 'REPORTED',
  ADD COLUMN IF NOT EXISTS our_share_pct numeric(6,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gross_amount  numeric(18,2) DEFAULT NULL;

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_large_losses_type
  ON public.contract_large_losses (report_id, loss_type);

CREATE INDEX IF NOT EXISTS idx_cat_losses_type
  ON public.contract_cat_losses (report_id, loss_type);
