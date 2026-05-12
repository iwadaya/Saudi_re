-- 072_database_alignment_and_index_cleanup.sql
--
-- Schema alignment and index hygiene found by the database design audit:
--   * Shared quote/contract tables now enforce a single owning entity.
--   * Quote-owned rows in shared tables get FK coverage.
--   * Pricing side tables cascade with their owning contract.
--   * Child-side FK columns get supporting indexes.
--   * Exact duplicate indexes/constraints are removed to reduce write cost.

-- contract_document is intentionally shared by contracts and quotes. Older
-- schema kept contract_id NOT NULL, which blocks quote-only document uploads.
ALTER TABLE public.contract_document
  ALTER COLUMN contract_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_contract_document_single_owner'
      AND conrelid = 'public.contract_document'::regclass
  ) THEN
    ALTER TABLE public.contract_document
      ADD CONSTRAINT chk_contract_document_single_owner
      CHECK (num_nonnulls(contract_id, quote_id) = 1) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_contract_large_loss_report_single_owner'
      AND conrelid = 'public.contract_large_loss_report'::regclass
  ) THEN
    ALTER TABLE public.contract_large_loss_report
      ADD CONSTRAINT chk_contract_large_loss_report_single_owner
      CHECK (num_nonnulls(contract_id, quote_id) = 1) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_contract_cat_loss_report_single_owner'
      AND conrelid = 'public.contract_cat_loss_report'::regclass
  ) THEN
    ALTER TABLE public.contract_cat_loss_report
      ADD CONSTRAINT chk_contract_cat_loss_report_single_owner
      CHECK (num_nonnulls(contract_id, quote_id) = 1) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_loss_sel_snap_single_owner'
      AND conrelid = 'public.contract_loss_selection_snapshot'::regclass
  ) THEN
    ALTER TABLE public.contract_loss_selection_snapshot
      ADD CONSTRAINT chk_loss_sel_snap_single_owner
      CHECK (num_nonnulls(contract_id, quote_id) = 1) NOT VALID;
  END IF;
END $$;

-- FKs for shared quote-owned rows. NOT VALID avoids scanning existing prod data
-- while still protecting all new inserts/updates after the migration.
SELECT public._add_fk_if_missing('contract_document',                'fk_contract_document_quote_id',             'quote_id',    'quote',    'quote_id');
SELECT public._add_fk_if_missing('contract_cat_loss_report',         'fk_contract_cat_loss_report_quote_id',      'quote_id',    'quote',    'quote_id');
SELECT public._add_fk_if_missing('contract_large_loss_report',       'fk_contract_large_loss_report_quote_id',    'quote_id',    'quote',    'quote_id');
SELECT public._add_fk_if_missing('contract_loss_selection_snapshot', 'fk_loss_selection_snapshot_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_loss_selection_snapshot', 'fk_loss_selection_snapshot_quote_id',       'quote_id',    'quote',    'quote_id');

-- Contract-owned pricing tables should not outlive their contract.
SELECT public._add_fk_if_missing('pricing_component_snapshots',      'fk_pricing_component_snapshots_contract_id','contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('pricing_components',               'fk_pricing_components_contract_id',         'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('pricing_leads',                    'fk_pricing_leads_contract_id',              'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('pricing_share_scenarios',          'fk_pricing_share_scenarios_contract_id',    'contract_id', 'contract', 'contract_id');

-- Child-side indexes for FK checks, cascade deletes, and common child loads.
CREATE INDEX IF NOT EXISTS idx_contract_broker_fk
  ON public.contract (broker_id)
  WHERE broker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_treaty_type_fk
  ON public.contract (treaty_type_id)
  WHERE treaty_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quote_broker_fk
  ON public.quote (broker_id)
  WHERE broker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quote_country_fk
  ON public.quote (country_id)
  WHERE country_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quote_treaty_type_fk
  ON public.quote (treaty_type_id)
  WHERE treaty_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_approval_contract_fk
  ON public.contract_approval (contract_id);

CREATE INDEX IF NOT EXISTS idx_contract_claims_profile_band_profile_fk
  ON public.contract_claims_profile_band (profile_id);

CREATE INDEX IF NOT EXISTS idx_contract_risk_profile_band_profile_fk
  ON public.contract_risk_profile_band (profile_id);

CREATE INDEX IF NOT EXISTS idx_contract_terms_snapshot_contract_fk
  ON public.contract_terms_snapshot (contract_id);

CREATE INDEX IF NOT EXISTS idx_contract_workflow_event_contract_fk
  ON public.contract_workflow_event (contract_id);

CREATE INDEX IF NOT EXISTS idx_quote_claims_profile_band_profile_fk
  ON public.quote_claims_profile_band (profile_id);

CREATE INDEX IF NOT EXISTS idx_quote_risk_profile_band_profile_fk
  ON public.quote_risk_profile_band (profile_id);

CREATE INDEX IF NOT EXISTS idx_ref_list_item_list_fk
  ON public.ref_list_item (list_id);

CREATE INDEX IF NOT EXISTS idx_formula_comments_parent_fk
  ON public.formula_comments (parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fac_document_uploaded_by_fk
  ON public.fac_document (uploaded_by)
  WHERE uploaded_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fac_location_country_fk
  ON public.fac_location (country_id)
  WHERE country_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fac_risk_broker_fk
  ON public.fac_risk (broker_id)
  WHERE broker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fac_risk_country_fk
  ON public.fac_risk (country_id)
  WHERE country_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fac_risk_created_by_user_fk
  ON public.fac_risk (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fac_risk_currency_fk
  ON public.fac_risk (currency_id)
  WHERE currency_id IS NOT NULL;

-- Redundant exact duplicates. Keep PK/UNIQUE indexes and the more selective
-- composite indexes; drop plain duplicates that only increase write overhead.
DROP INDEX IF EXISTS public.idx_audit_log_entity;
DROP INDEX IF EXISTS public.idx_companies_id;
DROP INDEX IF EXISTS public.idx_contract_renewal;
DROP INDEX IF EXISTS public.idx_assign_history_entity;
DROP INDEX IF EXISTS public.idx_quote_cat_report_lookup;
DROP INDEX IF EXISTS public.idx_quote_ll_report_lookup;
DROP INDEX IF EXISTS public.idx_ccob_contract_cob;
DROP INDEX IF EXISTS public.idx_qcob_quote_cob;
DROP INDEX IF EXISTS public.idx_contract_np_cat_ldf_devmonth;
DROP INDEX IF EXISTS public.idx_contract_np_cat_ult_year;
DROP INDEX IF EXISTS public.idx_np_details_contract;
DROP INDEX IF EXISTS public.idx_contract_np_excess_ldf_devmonth;
DROP INDEX IF EXISTS public.idx_np_expiring_layers_contract;
DROP INDEX IF EXISTS public.idx_np_expiring_terms_contract;
DROP INDEX IF EXISTS public.idx_np_hist_perf_contract;
DROP INDEX IF EXISTS public.idx_contract_np_ll_ldf_devmonth;
DROP INDEX IF EXISTS public.idx_contract_np_ll_ult_year;
DROP INDEX IF EXISTS public.idx_np_layer_cob_lookup;
DROP INDEX IF EXISTS public.idx_np_layers_cob_contract;
DROP INDEX IF EXISTS public.idx_np_layers_contract;
DROP INDEX IF EXISTS public.idx_np_terms_contract;
DROP INDEX IF EXISTS public.idx_contract_offer_contract;
DROP INDEX IF EXISTS public.idx_contract_pricing_outputs_contract;
DROP INDEX IF EXISTS public.idx_prop_details_contract;
DROP INDEX IF EXISTS public.idx_straight_exp_contract;
DROP INDEX IF EXISTS public.idx_country_id;
DROP INDEX IF EXISTS public.idx_fac_cope_risk;
DROP INDEX IF EXISTS public.idx_fac_pricing_risk;
DROP INDEX IF EXISTS public.idx_quote_np_cat_ldf_devmonth;
DROP INDEX IF EXISTS public.idx_quote_np_details;
DROP INDEX IF EXISTS public.idx_quote_np_excess_ldf_devmonth;
DROP INDEX IF EXISTS public.idx_quote_np_expiring_layers_qid;
DROP INDEX IF EXISTS public.idx_quote_np_expiring_terms_qid;
DROP INDEX IF EXISTS public.idx_quote_np_ll_ldf_devmonth;
DROP INDEX IF EXISTS public.idx_quote_np_layers_quote_layer;
DROP INDEX IF EXISTS public.idx_quote_np_terms;
DROP INDEX IF EXISTS public.idx_quote_np_terms_quote;
DROP INDEX IF EXISTS public.idx_quote_offer_quote;
DROP INDEX IF EXISTS public.idx_quote_pricing_outputs;
DROP INDEX IF EXISTS public.ix_ref_inflation_country_year;
DROP INDEX IF EXISTS public.idx_treaty_type_id;
DROP INDEX IF EXISTS public.idx_user_mandate;

-- Prefix duplicates superseded by composite ORDER BY indexes.
DROP INDEX IF EXISTS public.idx_quote_doc_lookup;
DROP INDEX IF EXISTS public.idx_offer_approval_event_contract;
DROP INDEX IF EXISTS public.idx_offer_approval_event_quote;
DROP INDEX IF EXISTS public.idx_offer_event_quote_id;
DROP INDEX IF EXISTS public.ix_loss_selection_snapshot_contract_type_created;

-- Duplicate uniqueness constraints. Equivalent PK/UNIQUE constraints remain.
ALTER TABLE public.quote_np_egnpi_year
  DROP CONSTRAINT IF EXISTS quote_np_egnpi_year_quote_year_unique;

ALTER TABLE public.quote_loss_participation
  DROP CONSTRAINT IF EXISTS quote_loss_participation_quote_id_key;

ALTER TABLE public.ref_list
  DROP CONSTRAINT IF EXISTS ref_list_key_unique;
