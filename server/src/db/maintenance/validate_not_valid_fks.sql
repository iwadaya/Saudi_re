-- server/src/db/maintenance/validate_not_valid_fks.sql
--
-- Batched ALTER TABLE … VALIDATE CONSTRAINT runbook for the 84 NOT VALID
-- foreign keys (P0-7). Generated from the catalog on 2026-06-20; regenerate
-- against the actual restored snapshot with fk_validation_emit.sql (STEP C),
-- since constraint membership can drift.
--
-- ⚠️  STAGING ONLY — run on a RESTORED PRODUCTION SNAPSHOT, never live prod.
-- ⚠️  PRECONDITIONS (do NOT skip):
--      1. node scripts/fk-orphan-report.js reported ZERO orphans, OR
--      2. archive-then-clean (fk_validation_emit.sql STEP B) was run for every
--         constraint that reported orphans, and the report was re-run clean.
--    A single orphan row makes that constraint's VALIDATE fail (the others in
--    the batch still succeed). See docs/runbooks/validate-not-valid-fks.md.
--
-- Each VALIDATE takes a SHARE UPDATE EXCLUSIVE lock on the child table and scans
-- it once: concurrent reads and writes continue, but DDL on that table blocks.
-- Run ONE batch (one \i / one transaction-free psql invocation) per quiet window;
-- the batches are independent and re-runnable (VALIDATE on an already-valid
-- constraint is a cheap no-op).

-- ── batch: contract  (contract (header reference FKs)) ──
ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_broker_id;
ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_cedant_id;
ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_country_id;

-- ── batch: contract_approval  (contract_* tables) ──
ALTER TABLE public.contract_approval VALIDATE CONSTRAINT fk_contract_approval_contract_id;

-- ── batch: contract_cat_loss_report  (contract_* tables) ──
ALTER TABLE public.contract_cat_loss_report VALIDATE CONSTRAINT fk_contract_cat_loss_report_contract_id;
ALTER TABLE public.contract_cat_loss_report VALIDATE CONSTRAINT fk_contract_cat_loss_report_quote_id;

-- ── batch: contract_cat_losses  (contract_* tables) ──
ALTER TABLE public.contract_cat_losses VALIDATE CONSTRAINT fk_contract_cat_losses_report_id;

-- ── batch: contract_claims_profile  (contract_* tables) ──
ALTER TABLE public.contract_claims_profile VALIDATE CONSTRAINT fk_contract_claims_profile_contract_id;

-- ── batch: contract_claims_profile_band  (contract_* tables) ──
ALTER TABLE public.contract_claims_profile_band VALIDATE CONSTRAINT fk_contract_claims_profile_band_profile_id;

-- ── batch: contract_class_of_business  (contract_* tables) ──
ALTER TABLE public.contract_class_of_business VALIDATE CONSTRAINT fk_contract_class_of_business_contract_id;

-- ── batch: contract_commission_slides  (contract_* tables) ──
ALTER TABLE public.contract_commission_slides VALIDATE CONSTRAINT fk_contract_commission_slides_contract_id;

-- ── batch: contract_commissions  (contract_* tables) ──
ALTER TABLE public.contract_commissions VALIDATE CONSTRAINT fk_contract_commissions_contract_id;

-- ── batch: contract_cresta_data  (contract_* tables) ──
ALTER TABLE public.contract_cresta_data VALIDATE CONSTRAINT fk_contract_cresta_data_contract_id;

-- ── batch: contract_dev_factor  (contract_* tables) ──
ALTER TABLE public.contract_dev_factor VALIDATE CONSTRAINT fk_contract_dev_factor_contract_id;

-- ── batch: contract_document  (contract_* tables) ──
ALTER TABLE public.contract_document VALIDATE CONSTRAINT fk_contract_document_contract_id;
ALTER TABLE public.contract_document VALIDATE CONSTRAINT fk_contract_document_quote_id;

-- ── batch: contract_epi_split  (contract_* tables) ──
ALTER TABLE public.contract_epi_split VALIDATE CONSTRAINT fk_contract_epi_split_contract_id;

-- ── batch: contract_event_loss_tables  (contract_* tables) ──
ALTER TABLE public.contract_event_loss_tables VALIDATE CONSTRAINT fk_contract_event_loss_tables_contract_id;

-- ── batch: contract_large_loss_report  (contract_* tables) ──
ALTER TABLE public.contract_large_loss_report VALIDATE CONSTRAINT fk_contract_large_loss_report_contract_id;
ALTER TABLE public.contract_large_loss_report VALIDATE CONSTRAINT fk_contract_large_loss_report_quote_id;

-- ── batch: contract_large_losses  (contract_* tables) ──
ALTER TABLE public.contract_large_losses VALIDATE CONSTRAINT fk_contract_large_losses_report_id;

-- ── batch: contract_loss_participation  (contract_* tables) ──
ALTER TABLE public.contract_loss_participation VALIDATE CONSTRAINT fk_contract_loss_participation_contract_id;

-- ── batch: contract_loss_selection_snapshot  (contract_* tables) ──
ALTER TABLE public.contract_loss_selection_snapshot VALIDATE CONSTRAINT fk_loss_selection_snapshot_contract_id;
ALTER TABLE public.contract_loss_selection_snapshot VALIDATE CONSTRAINT fk_loss_selection_snapshot_quote_id;

-- ── batch: contract_np_details  (contract_* tables) ──
ALTER TABLE public.contract_np_details VALIDATE CONSTRAINT fk_contract_np_details_contract_id;

-- ── batch: contract_np_egnpi_year  (contract_* tables) ──
ALTER TABLE public.contract_np_egnpi_year VALIDATE CONSTRAINT fk_contract_np_egnpi_year_contract_id;

-- ── batch: contract_np_expiring_layers  (contract_* tables) ──
ALTER TABLE public.contract_np_expiring_layers VALIDATE CONSTRAINT fk_contract_np_expiring_layers_contract_id;

-- ── batch: contract_np_expiring_terms  (contract_* tables) ──
ALTER TABLE public.contract_np_expiring_terms VALIDATE CONSTRAINT fk_contract_np_expiring_terms_contract_id;

-- ── batch: contract_np_layer_class_of_business  (contract_* tables) ──
ALTER TABLE public.contract_np_layer_class_of_business VALIDATE CONSTRAINT fk_contract_np_layer_cob_layer_id;

-- ── batch: contract_np_layers  (contract_* tables) ──
ALTER TABLE public.contract_np_layers VALIDATE CONSTRAINT fk_contract_np_layers_contract_id;

-- ── batch: contract_np_pricing_inputs  (contract_* tables) ──
ALTER TABLE public.contract_np_pricing_inputs VALIDATE CONSTRAINT fk_contract_np_pricing_inputs_contract_id;

-- ── batch: contract_np_pricing_layer_inputs  (contract_* tables) ──
ALTER TABLE public.contract_np_pricing_layer_inputs VALIDATE CONSTRAINT fk_contract_np_pricing_layer_inputs_contract_id;

-- ── batch: contract_np_pricing_outputs  (contract_* tables) ──
ALTER TABLE public.contract_np_pricing_outputs VALIDATE CONSTRAINT fk_contract_np_pricing_outputs_contract_id;

-- ── batch: contract_np_terms  (contract_* tables) ──
ALTER TABLE public.contract_np_terms VALIDATE CONSTRAINT fk_contract_np_terms_contract_id;

-- ── batch: contract_offer  (contract_* tables) ──
ALTER TABLE public.contract_offer VALIDATE CONSTRAINT fk_contract_offer_contract_id;

-- ── batch: contract_pricing_outputs  (contract_* tables) ──
ALTER TABLE public.contract_pricing_outputs VALIDATE CONSTRAINT fk_contract_pricing_outputs_contract_id;

-- ── batch: contract_pricing_patterns  (contract_* tables) ──
ALTER TABLE public.contract_pricing_patterns VALIDATE CONSTRAINT fk_contract_pricing_patterns_contract_id;

-- ── batch: contract_pricing_yearly  (contract_* tables) ──
ALTER TABLE public.contract_pricing_yearly VALIDATE CONSTRAINT fk_contract_pricing_yearly_contract_id;

-- ── batch: contract_prop_details  (contract_* tables) ──
ALTER TABLE public.contract_prop_details VALIDATE CONSTRAINT fk_contract_prop_details_contract_id;

-- ── batch: contract_risk_profile  (contract_* tables) ──
ALTER TABLE public.contract_risk_profile VALIDATE CONSTRAINT fk_contract_risk_profile_contract_id;

-- ── batch: contract_risk_profile_band  (contract_* tables) ──
ALTER TABLE public.contract_risk_profile_band VALIDATE CONSTRAINT fk_contract_risk_profile_band_profile_id;

-- ── batch: contract_straight_experience  (contract_* tables) ──
ALTER TABLE public.contract_straight_experience VALIDATE CONSTRAINT fk_contract_straight_experience_contract_id;

-- ── batch: contract_straight_uw_stats  (contract_* tables) ──
ALTER TABLE public.contract_straight_uw_stats VALIDATE CONSTRAINT fk_contract_straight_uw_stats_contract_id;

-- ── batch: contract_terms_snapshot  (contract_* tables) ──
ALTER TABLE public.contract_terms_snapshot VALIDATE CONSTRAINT fk_contract_terms_snapshot_contract_id;

-- ── batch: contract_triangle_cells  (contract_* tables) ──
ALTER TABLE public.contract_triangle_cells VALIDATE CONSTRAINT fk_contract_triangle_cells_contract_id;

-- ── batch: contract_underwriting_limit  (contract_* tables) ──
ALTER TABLE public.contract_underwriting_limit VALIDATE CONSTRAINT fk_contract_underwriting_limit_contract_id;

-- ── batch: contract_workflow_event  (contract_* tables) ──
ALTER TABLE public.contract_workflow_event VALIDATE CONSTRAINT fk_contract_workflow_event_contract_id;

-- ── batch: pricing_component_snapshots  (pricing_* tables) ──
ALTER TABLE public.pricing_component_snapshots VALIDATE CONSTRAINT fk_pricing_component_snapshots_contract_id;

-- ── batch: pricing_components  (pricing_* tables) ──
ALTER TABLE public.pricing_components VALIDATE CONSTRAINT fk_pricing_components_contract_id;

-- ── batch: pricing_leads  (pricing_* tables) ──
ALTER TABLE public.pricing_leads VALIDATE CONSTRAINT fk_pricing_leads_contract_id;

-- ── batch: pricing_share_scenarios  (pricing_* tables) ──
ALTER TABLE public.pricing_share_scenarios VALIDATE CONSTRAINT fk_pricing_share_scenarios_contract_id;

-- ── batch: quote  (quote (header reference FKs)) ──
ALTER TABLE public.quote VALIDATE CONSTRAINT fk_quote_broker_id;
ALTER TABLE public.quote VALIDATE CONSTRAINT fk_quote_cedant_id;
ALTER TABLE public.quote VALIDATE CONSTRAINT fk_quote_country_id;

-- ── batch: quote_cat_loss_report  (quote_* tables) ──
ALTER TABLE public.quote_cat_loss_report VALIDATE CONSTRAINT fk_quote_cat_loss_report_quote_id;

-- ── batch: quote_cedant_exposure  (quote_* tables) ──
ALTER TABLE public.quote_cedant_exposure VALIDATE CONSTRAINT fk_quote_cedant_exposure_quote_id;

-- ── batch: quote_claims_profile  (quote_* tables) ──
ALTER TABLE public.quote_claims_profile VALIDATE CONSTRAINT fk_quote_claims_profile_quote_id;

-- ── batch: quote_claims_profile_band  (quote_* tables) ──
ALTER TABLE public.quote_claims_profile_band VALIDATE CONSTRAINT fk_quote_claims_profile_band_profile_id;

-- ── batch: quote_class_of_business  (quote_* tables) ──
ALTER TABLE public.quote_class_of_business VALIDATE CONSTRAINT fk_quote_class_of_business_quote_id;

-- ── batch: quote_commission_slides  (quote_* tables) ──
ALTER TABLE public.quote_commission_slides VALIDATE CONSTRAINT fk_quote_commission_slides_quote_id;

-- ── batch: quote_commissions  (quote_* tables) ──
ALTER TABLE public.quote_commissions VALIDATE CONSTRAINT fk_quote_commissions_quote_id;

-- ── batch: quote_cresta_data  (quote_* tables) ──
ALTER TABLE public.quote_cresta_data VALIDATE CONSTRAINT fk_quote_cresta_data_quote_id;

-- ── batch: quote_dev_factor  (quote_* tables) ──
ALTER TABLE public.quote_dev_factor VALIDATE CONSTRAINT fk_quote_dev_factor_quote_id;

-- ── batch: quote_epi_split  (quote_* tables) ──
ALTER TABLE public.quote_epi_split VALIDATE CONSTRAINT fk_quote_epi_split_quote_id;

-- ── batch: quote_large_loss_report  (quote_* tables) ──
ALTER TABLE public.quote_large_loss_report VALIDATE CONSTRAINT fk_quote_large_loss_report_quote_id;

-- ── batch: quote_loss_participation  (quote_* tables) ──
ALTER TABLE public.quote_loss_participation VALIDATE CONSTRAINT fk_quote_loss_participation_quote_id;

-- ── batch: quote_np_details  (quote_* tables) ──
ALTER TABLE public.quote_np_details VALIDATE CONSTRAINT fk_quote_np_details_quote_id;

-- ── batch: quote_np_egnpi_year  (quote_* tables) ──
ALTER TABLE public.quote_np_egnpi_year VALIDATE CONSTRAINT fk_quote_np_egnpi_year_quote_id;

-- ── batch: quote_np_expiring_layers  (quote_* tables) ──
ALTER TABLE public.quote_np_expiring_layers VALIDATE CONSTRAINT fk_quote_np_expiring_layers_quote_id;

-- ── batch: quote_np_expiring_terms  (quote_* tables) ──
ALTER TABLE public.quote_np_expiring_terms VALIDATE CONSTRAINT fk_quote_np_expiring_terms_quote_id;

-- ── batch: quote_np_layers  (quote_* tables) ──
ALTER TABLE public.quote_np_layers VALIDATE CONSTRAINT fk_quote_np_layers_quote_id;

-- ── batch: quote_np_pricing_inputs  (quote_* tables) ──
ALTER TABLE public.quote_np_pricing_inputs VALIDATE CONSTRAINT fk_quote_np_pricing_inputs_quote_id;

-- ── batch: quote_np_pricing_layer_inputs  (quote_* tables) ──
ALTER TABLE public.quote_np_pricing_layer_inputs VALIDATE CONSTRAINT fk_quote_np_pricing_layer_inputs_quote_id;

-- ── batch: quote_np_pricing_outputs  (quote_* tables) ──
ALTER TABLE public.quote_np_pricing_outputs VALIDATE CONSTRAINT fk_quote_np_pricing_outputs_quote_id;

-- ── batch: quote_np_terms  (quote_* tables) ──
ALTER TABLE public.quote_np_terms VALIDATE CONSTRAINT fk_quote_np_terms_quote_id;

-- ── batch: quote_offer  (quote_* tables) ──
ALTER TABLE public.quote_offer VALIDATE CONSTRAINT fk_quote_offer_quote_id;

-- ── batch: quote_pricing_outputs  (quote_* tables) ──
ALTER TABLE public.quote_pricing_outputs VALIDATE CONSTRAINT fk_quote_pricing_outputs_quote_id;

-- ── batch: quote_pricing_yearly  (quote_* tables) ──
ALTER TABLE public.quote_pricing_yearly VALIDATE CONSTRAINT fk_quote_pricing_yearly_quote_id;

-- ── batch: quote_prop_details  (quote_* tables) ──
ALTER TABLE public.quote_prop_details VALIDATE CONSTRAINT fk_quote_prop_details_quote_id;

-- ── batch: quote_risk_profile  (quote_* tables) ──
ALTER TABLE public.quote_risk_profile VALIDATE CONSTRAINT fk_quote_risk_profile_quote_id;

-- ── batch: quote_risk_profile_band  (quote_* tables) ──
ALTER TABLE public.quote_risk_profile_band VALIDATE CONSTRAINT fk_quote_risk_profile_band_profile_id;

-- ── batch: quote_triangle_cells  (quote_* tables) ──
ALTER TABLE public.quote_triangle_cells VALIDATE CONSTRAINT fk_quote_triangle_cells_quote_id;

-- ── batch: quote_underwriting_limit  (quote_* tables) ──
ALTER TABLE public.quote_underwriting_limit VALIDATE CONSTRAINT fk_quote_underwriting_limit_quote_id;

-- ── batch: ref_list_item  (ref_* tables) ──
ALTER TABLE public.ref_list_item VALIDATE CONSTRAINT fk_ref_list_item_list_id;

-- 84 VALIDATE statements total.
