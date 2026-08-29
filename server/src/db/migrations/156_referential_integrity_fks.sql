-- 156: Referential-integrity retrofit — missing FKs on identity/money-bearing
--       columns and covering indexes for FK child columns (audit F87, F90).
--
-- uw_user.role_id (F87): NOT NULL since 000 but carried no FK — the 000 core
-- dump omitted it and the FK'd definitions in 001/034 were CREATE TABLE IF
-- NOT EXISTS no-ops. A dangling role_id silently removes the user from
-- v_user_mandate (the INNER JOIN view login and approvals routing read).
-- ON DELETE RESTRICT: a role that still has users must not be deletable.
--
-- F90 highlights (each verified 0 orphans on the live test DB before
-- writing; the defensive pre-cleans below are no-ops there and follow the
-- 148/057 retrofit pattern — clean, ADD ... NOT VALID, VALIDATE in the same
-- migration):
--   * contract.currency_id / quote.currency_id  -> currency   (NO ACTION —
--     reference data in use must not be deletable)
--   * companies.country_id / ref_cresta_zone.country_id -> country (NO ACTION)
--   * contract.source_quote_id  -> quote     ON DELETE SET NULL (quote
--     deletes currently succeed leaving a dangling pointer; SET NULL keeps
--     the delete working and removes the dangle — the audit found exactly
--     such an orphan on this DB earlier)
--   * contract.parent_contract_id -> contract ON DELETE SET NULL (renewal
--     lineage; child must survive parent deletion)
--   * contract.contract_group_id  -> contract_group ON DELETE SET NULL
--   * quote.bound_contract_id     -> contract ON DELETE SET NULL
--   * contract_large_losses.contract_id / contract_cat_losses.contract_id
--     -> contract ON DELETE CASCADE (money-bearing loss rows; today they are
--     tied to contract only transitively via report_id, so the denormalized
--     contract_id could silently diverge)
--
-- DELIBERATELY SKIPPED (flagged for a product decision, not forgotten):
--   * contract_audit_event.contract_id — the live DB holds thousands of
--     audit rows for deleted contracts (2,900 at time of writing). The audit
--     trail is meant to outlive its entity; an FK would either destroy
--     history (CASCADE) or block every contract delete (NO ACTION). Needs an
--     archival design, not a constraint.
--
-- Finally: covering indexes for every FK child column that had neither a
-- full nor a partial (col IS NOT NULL) index prefix — 54+ columns whose
-- parent-side deletes and reverse lookups were full scans. Generated from
-- pg_constraint/pg_index on the live DB; CREATE INDEX IF NOT EXISTS keeps
-- them idempotent.

-- ── F87: uw_user.role_id -> uw_role ─────────────────────────────────────────
-- role_id is NOT NULL, so orphans (none found) would make the VALIDATE fail
-- loudly — which is correct: a user with a dangling role must be repaired by
-- an operator, not silently accepted.
ALTER TABLE public.uw_user
  ADD CONSTRAINT uw_user_role_id_fkey
  FOREIGN KEY (role_id) REFERENCES public.uw_role(role_id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.uw_user VALIDATE CONSTRAINT uw_user_role_id_fkey;

-- ── F90: reference-data FKs (NO ACTION) ─────────────────────────────────────
ALTER TABLE public.contract
  ADD CONSTRAINT fk_contract_currency_id
  FOREIGN KEY (currency_id) REFERENCES public.currency(currency_id)
  NOT VALID;

ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_currency_id;

ALTER TABLE public.quote
  ADD CONSTRAINT fk_quote_currency_id
  FOREIGN KEY (currency_id) REFERENCES public.currency(currency_id)
  NOT VALID;

ALTER TABLE public.quote VALIDATE CONSTRAINT fk_quote_currency_id;

UPDATE public.companies co SET country_id = NULL
 WHERE co.country_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.country c WHERE c.country_id = co.country_id);

ALTER TABLE public.companies
  ADD CONSTRAINT fk_companies_country_id
  FOREIGN KEY (country_id) REFERENCES public.country(country_id)
  NOT VALID;

ALTER TABLE public.companies VALIDATE CONSTRAINT fk_companies_country_id;

ALTER TABLE public.ref_cresta_zone
  ADD CONSTRAINT fk_ref_cresta_zone_country_id
  FOREIGN KEY (country_id) REFERENCES public.country(country_id)
  NOT VALID;

ALTER TABLE public.ref_cresta_zone VALIDATE CONSTRAINT fk_ref_cresta_zone_country_id;

-- ── F90: lineage / linkage FKs (SET NULL) ───────────────────────────────────
UPDATE public.contract c SET source_quote_id = NULL
 WHERE c.source_quote_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.quote q WHERE q.quote_id = c.source_quote_id);

ALTER TABLE public.contract
  ADD CONSTRAINT fk_contract_source_quote_id
  FOREIGN KEY (source_quote_id) REFERENCES public.quote(quote_id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_source_quote_id;

UPDATE public.contract c SET parent_contract_id = NULL
 WHERE c.parent_contract_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.contract p WHERE p.contract_id = c.parent_contract_id);

ALTER TABLE public.contract
  ADD CONSTRAINT fk_contract_parent_contract_id
  FOREIGN KEY (parent_contract_id) REFERENCES public.contract(contract_id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_parent_contract_id;

UPDATE public.contract c SET contract_group_id = NULL
 WHERE c.contract_group_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.contract_group g WHERE g.contract_group_id = c.contract_group_id);

ALTER TABLE public.contract
  ADD CONSTRAINT fk_contract_contract_group_id
  FOREIGN KEY (contract_group_id) REFERENCES public.contract_group(contract_group_id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.contract VALIDATE CONSTRAINT fk_contract_contract_group_id;

UPDATE public.quote q SET bound_contract_id = NULL
 WHERE q.bound_contract_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.contract c WHERE c.contract_id = q.bound_contract_id);

ALTER TABLE public.quote
  ADD CONSTRAINT fk_quote_bound_contract_id
  FOREIGN KEY (bound_contract_id) REFERENCES public.contract(contract_id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.quote VALIDATE CONSTRAINT fk_quote_bound_contract_id;

-- ── F90: money-bearing loss rows (CASCADE) ──────────────────────────────────
-- contract_id is nullable on both tables (report-only rows keep NULL); rows
-- pointing at a deleted contract are removed, matching what the report-level
-- CASCADE (057) already does for the report-linked path.
DELETE FROM public.contract_large_losses l
 WHERE l.contract_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.contract c WHERE c.contract_id = l.contract_id);

ALTER TABLE public.contract_large_losses
  ADD CONSTRAINT fk_contract_large_losses_contract_id
  FOREIGN KEY (contract_id) REFERENCES public.contract(contract_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.contract_large_losses VALIDATE CONSTRAINT fk_contract_large_losses_contract_id;

DELETE FROM public.contract_cat_losses l
 WHERE l.contract_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.contract c WHERE c.contract_id = l.contract_id);

ALTER TABLE public.contract_cat_losses
  ADD CONSTRAINT fk_contract_cat_losses_contract_id
  FOREIGN KEY (contract_id) REFERENCES public.contract(contract_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.contract_cat_losses VALIDATE CONSTRAINT fk_contract_cat_losses_contract_id;

-- ── Covering indexes for the new FK columns above ───────────────────────────
-- (parent_contract_id / source_quote_id / bound_contract_id /
-- companies.country_id already carry partial "IS NOT NULL" indexes, which
-- cover FK lookups; large/cat losses carry idx_large_loss_contract /
-- idx_cat_loss_contract; uw_user.role_id carries idx_uw_user_role.)
CREATE INDEX IF NOT EXISTS idx_fk_contract_currency_id ON public.contract (currency_id);

CREATE INDEX IF NOT EXISTS idx_fk_quote_currency_id ON public.quote (currency_id);

CREATE INDEX IF NOT EXISTS idx_fk_contract_contract_group_id ON public.contract (contract_group_id);

CREATE INDEX IF NOT EXISTS idx_fk_ref_cresta_zone_country_id ON public.ref_cresta_zone (country_id);

-- ── Covering indexes for pre-existing FK child columns with no usable index
--    (generated from pg_constraint/pg_index on the live DB) ─────────────────
CREATE INDEX IF NOT EXISTS idx_fk_auth_session_user_id ON public.auth_session (user_id);
CREATE INDEX IF NOT EXISTS idx_fk_cedant_ai_recommendation_acted_by_user_id ON public.cedant_ai_recommendation (acted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_cedant_ai_recommendation_set_created_by_user_id ON public.cedant_ai_recommendation_set (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_cedant_portfolio_staging_contract_id ON public.cedant_portfolio_staging (contract_id);
CREATE INDEX IF NOT EXISTS idx_fk_cedant_portfolio_staging_created_by_user_id ON public.cedant_portfolio_staging (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_cedant_portfolio_staging_source_rec_id ON public.cedant_portfolio_staging (source_rec_id);
CREATE INDEX IF NOT EXISTS idx_fk_cedant_portfolio_staging_warning_acknowledged_by_user_id ON public.cedant_portfolio_staging (warning_acknowledged_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_assigned_to_user_id ON public.claim (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_class_of_business_id ON public.claim (class_of_business_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_created_by_user_id ON public.claim (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_currency_id ON public.claim (currency_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_document_uploaded_by_user_id ON public.claim_document (uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_movement_created_by_user_id ON public.claim_movement (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_note_created_by_user_id ON public.claim_note (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_reviewed_by_user_id ON public.claim (reviewed_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_claim_submitted_by_user_id ON public.claim (submitted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_contract_ldf_blend_weight_class_of_business_id ON public.contract_ldf_blend_weight (class_of_business_id);
CREATE INDEX IF NOT EXISTS idx_fk_contract_wording_checklist_analysis_run_id ON public.contract_wording_checklist (analysis_run_id);
CREATE INDEX IF NOT EXISTS idx_fk_contract_wording_checklist_checked_by_user_id ON public.contract_wording_checklist (checked_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_contract_wording_checklist_document_id ON public.contract_wording_checklist (document_id);
CREATE INDEX IF NOT EXISTS idx_fk_contract_wording_checklist_item_key ON public.contract_wording_checklist (item_key);
CREATE INDEX IF NOT EXISTS idx_fk_contract_wording_checklist_run_document_id ON public.contract_wording_checklist_run (document_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_ai_recommendation_acted_by_user_id ON public.fac_ai_recommendation (acted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_ai_recommendation_analysis_id ON public.fac_ai_recommendation (analysis_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_clauses_checklist_clause_code ON public.fac_clauses_checklist (clause_code);
CREATE INDEX IF NOT EXISTS idx_fk_fac_curve_band_curve_id ON public.fac_curve_band (curve_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_document_analysis_document_id ON public.fac_document_analysis (document_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_document_uploaded_by_user_id ON public.fac_document (uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_factor_weight_factor_code ON public.fac_factor_weight (factor_code);
CREATE INDEX IF NOT EXISTS idx_fk_fac_layer_section_id ON public.fac_layer (section_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_liability_base_rate_fac_cob_id ON public.fac_liability_base_rate (fac_cob_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_location_occupancy_code ON public.fac_location (occupancy_code);
CREATE INDEX IF NOT EXISTS idx_fk_fac_loss_history_currency_id ON public.fac_loss_history (currency_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_loss_history_section_id ON public.fac_loss_history (section_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_pricing_drift_fac_risk_id ON public.fac_pricing_drift (fac_risk_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_pricing_method_section_id ON public.fac_pricing_method (section_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_rate_stage_created_by ON public.fac_rate_stage (created_by);
CREATE INDEX IF NOT EXISTS idx_fk_fac_rate_table_version_approved_by ON public.fac_rate_table_version (approved_by);
CREATE INDEX IF NOT EXISTS idx_fk_fac_rate_table_version_created_by ON public.fac_rate_table_version (created_by);
CREATE INDEX IF NOT EXISTS idx_fk_fac_rate_table_version_rejected_by ON public.fac_rate_table_version (rejected_by);
CREATE INDEX IF NOT EXISTS idx_fk_fac_rate_table_version_submitted_by ON public.fac_rate_table_version (submitted_by);
CREATE INDEX IF NOT EXISTS idx_fk_fac_rate_version_event_actor_id ON public.fac_rate_version_event (actor_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_risk_occupancy_code ON public.fac_risk (occupancy_code);
CREATE INDEX IF NOT EXISTS idx_fk_fac_risk_section_currency_id ON public.fac_risk_section (currency_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_to_treaty_cob_map_class_of_business_id ON public.fac_to_treaty_cob_map (class_of_business_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_treaty_link_created_by_user_id ON public.fac_treaty_link (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_fac_zone_budget_country_id ON public.fac_zone_budget (country_id);
CREATE INDEX IF NOT EXISTS idx_fk_finance_treaty_entry_acknowledged_by_user_id ON public.finance_treaty_entry (acknowledged_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_import_snapshots_job_id ON public.import_snapshots (job_id);
CREATE INDEX IF NOT EXISTS idx_fk_market_intelligence_recommendation_acted_by_user_id ON public.market_intelligence_recommendation (acted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_market_intelligence_report_class_of_business_id ON public.market_intelligence_report (class_of_business_id);
CREATE INDEX IF NOT EXISTS idx_fk_market_intelligence_report_generated_by_user_id ON public.market_intelligence_report (generated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_quote_np_final_structure_cob_class_of_business_id ON public.quote_np_final_structure_cob (class_of_business_id);
CREATE INDEX IF NOT EXISTS idx_fk_retro_pack_document_uploaded_by_user_id ON public.retro_pack_document (uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_retro_programme_created_by_user_id ON public.retro_programme (created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_fk_uw_user_company_id ON public.uw_user (company_id);
