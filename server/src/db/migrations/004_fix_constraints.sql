-- Migration 004: Fix missing constraints for upsert operations
-- Run AFTER the base schema (outputfile.sql).

BEGIN;

-- Partial unique indexes on quote_id for shared loss report tables
-- (contract_large_loss_report and contract_cat_loss_report have
--  UNIQUE(contract_id) but NOT UNIQUE(quote_id))
CREATE UNIQUE INDEX IF NOT EXISTS idx_large_loss_report_quote_id
  ON public.contract_large_loss_report (quote_id)
  WHERE quote_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_loss_report_quote_id
  ON public.contract_cat_loss_report (quote_id)
  WHERE quote_id IS NOT NULL;

-- Optional: add unique(contract_id) on contract_offer for upsert support
-- The app currently uses delete+insert, so this is not strictly required
-- but makes future development easier.
-- Uncomment if you want to enable ON CONFLICT upserts on contract_offer:
-- ALTER TABLE public.contract_offer ADD CONSTRAINT contract_offer_contract_id_key UNIQUE (contract_id);

COMMIT;
