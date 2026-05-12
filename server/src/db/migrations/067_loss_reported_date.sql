-- 067_loss_reported_date.sql
-- Capture WHEN each individual loss was reported / put into a contract.
-- We already have contract_*_loss_report.report_date (a single date for the
-- whole report), but on renewal we need to compare losses report-over-report
-- and flag new ones / discrepancies. To do that we need a per-loss "reported
-- date" so a row added to an existing report can be distinguished from rows
-- that were already there last cycle.

ALTER TABLE public.contract_large_losses
  ADD COLUMN IF NOT EXISTS reported_date date;

ALTER TABLE public.contract_cat_losses
  ADD COLUMN IF NOT EXISTS reported_date date;

-- Backfill: for existing rows, fall back to created_at::date so historical
-- losses don't all show up as "new" in the analysis modal.
UPDATE public.contract_large_losses
   SET reported_date = created_at::date
 WHERE reported_date IS NULL;

UPDATE public.contract_cat_losses
   SET reported_date = created_at::date
 WHERE reported_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_large_losses_reported_date
  ON public.contract_large_losses (report_id, reported_date);

CREATE INDEX IF NOT EXISTS idx_cat_losses_reported_date
  ON public.contract_cat_losses (report_id, reported_date);
