-- Migration 003: Performance indexes and updated_at triggers
-- Safe to run on top of the base outputfile.sql schema.

BEGIN;

-- Quote sub-table indexes (many are missing from the base dump)
CREATE INDEX IF NOT EXISTS idx_quote_triangle_lookup
  ON public.quote_triangle_cells (quote_id, type);
CREATE INDEX IF NOT EXISTS idx_quote_cresta
  ON public.quote_cresta_data (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_risk_profile
  ON public.quote_risk_profile (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_claims_profile
  ON public.quote_claims_profile (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_commission_slides
  ON public.quote_commission_slides (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_np_details
  ON public.quote_np_details (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_np_layers
  ON public.quote_np_layers (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_np_terms
  ON public.quote_np_terms (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_pricing_outputs
  ON public.quote_pricing_outputs (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_dev_factor
  ON public.quote_dev_factor (quote_id, triangle_type);
CREATE INDEX IF NOT EXISTS idx_quote_underwriting_limit
  ON public.quote_underwriting_limit (quote_id);

-- Quote FK lookups on shared tables
CREATE INDEX IF NOT EXISTS idx_quote_doc_lookup
  ON public.contract_document (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_ll_report_lookup
  ON public.contract_large_loss_report (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_cat_report_lookup
  ON public.contract_cat_loss_report (quote_id) WHERE quote_id IS NOT NULL;

-- Contract table indexes
CREATE INDEX IF NOT EXISTS idx_contract_status ON public.contract (uw_status);
CREATE INDEX IF NOT EXISTS idx_contract_cedant ON public.contract (cedant_id);
CREATE INDEX IF NOT EXISTS idx_contract_uw_year ON public.contract (uw_year);
CREATE INDEX IF NOT EXISTS idx_contract_renewal ON public.contract (renewal_date) WHERE renewal_date IS NOT NULL;

-- Ensure set_updated_at trigger function exists
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- Add triggers for tables that have updated_at but may lack triggers
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'contract_cat_loss_report','contract_large_loss_report',
    'contract_epi_split','contract_np_terms',
    'quote_np_egnpi_year','quote_np_terms','quote_epi_split',
    'ref_country_inflation'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=tbl)
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || tbl || '_updated')
    THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
        replace(tbl,'.','_'), tbl
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
