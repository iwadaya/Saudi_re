-- server/src/db/migrations/057_foreign_key_retrofit.sql
--
-- Retrofit the 67+ child tables that carry contract_id/quote_id NOT NULL
-- but have no FK declared, plus the cedant_id/broker_id/country_id
-- reference columns. Identified by the data-model audit.
--
-- Strategy:
--   * ALL additions use NOT VALID. This means:
--       - No lock is taken to re-scan existing rows.
--       - Existing orphan rows (if any) are tolerated; they are NOT
--         validated against the FK.
--       - Every NEW insert/update IS gated — so the hole closes
--         immediately for forward-looking writes.
--     Operators can run `ALTER TABLE ... VALIDATE CONSTRAINT ...` out
--     of hours once any existing orphans are cleaned.
--   * Child tables use ON DELETE CASCADE — deleting a contract/quote
--     removes its sub-entities. Matches the app's existing behaviour
--     where DELETE /api/treaties/:id expects sub-tables to vanish.
--   * Reference columns (cedant_id, broker_id, country_id) use
--     ON DELETE RESTRICT — deleting a cedant that owns contracts
--     should fail loudly, not null out historical records.
--   * Idempotent via a helper function that checks pg_constraint
--     before adding, so this migration can be replayed safely.
--
-- Not covered here (deliberately):
--   * contract_loss_selection_snapshot — contract_id is nullable and
--     gated by a CHECK constraint (contract OR quote). Adding a
--     nullable FK is the right move but requires a separate pass
--     to also FK the quote_id side without breaking the CHECK.
--   * Free-text enum columns (class_of_business, triangle_type). FK
--     to a class_of_business table exists in some places; full
--     normalisation is its own project.

CREATE OR REPLACE FUNCTION public._add_fk_if_missing(
  p_table      text,
  p_constraint text,
  p_column     text,
  p_ref_table  text,
  p_ref_col    text,
  p_on_delete  text DEFAULT 'CASCADE'
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Skip if the table or the referenced table doesn't exist yet
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = p_table AND relnamespace = 'public'::regnamespace) THEN
    RAISE NOTICE 'skip fk % — table public.% does not exist', p_constraint, p_table;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = p_ref_table AND relnamespace = 'public'::regnamespace) THEN
    RAISE NOTICE 'skip fk % — referenced table public.% does not exist', p_constraint, p_ref_table;
    RETURN;
  END IF;
  -- Skip if the column doesn't exist on the source table
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_column
  ) THEN
    RAISE NOTICE 'skip fk % — column %.% does not exist', p_constraint, p_table, p_column;
    RETURN;
  END IF;
  -- Skip if any FK on this table/column already exists (by our name OR another)
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class r ON c.conrelid = r.oid
    JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND r.relname = p_table AND a.attname = p_column
  ) THEN
    RAISE NOTICE 'skip fk % — a foreign key already exists on %.%', p_constraint, p_table, p_column;
    RETURN;
  END IF;

  EXECUTE format(
    'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(%I) ON DELETE %s NOT VALID',
    p_table, p_constraint, p_column, p_ref_table, p_ref_col, p_on_delete
  );
  RAISE NOTICE 'added fk %: public.%(%) -> public.%(%) on delete %', p_constraint, p_table, p_column, p_ref_table, p_ref_col, p_on_delete;
END$$;

-- ─── Contract children (ON DELETE CASCADE) ─────────────────────────
SELECT public._add_fk_if_missing('contract_approval',                 'fk_contract_approval_contract_id',             'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_audit_event',              'fk_contract_audit_event_contract_id',          'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_cat_loss_report',          'fk_contract_cat_loss_report_contract_id',      'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_claims_profile',           'fk_contract_claims_profile_contract_id',       'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_class_of_business',        'fk_contract_class_of_business_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_commission_slides',        'fk_contract_commission_slides_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_commissions',              'fk_contract_commissions_contract_id',          'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_cresta_data',              'fk_contract_cresta_data_contract_id',          'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_dev_factor',               'fk_contract_dev_factor_contract_id',           'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_document',                 'fk_contract_document_contract_id',             'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_epi_split',                'fk_contract_epi_split_contract_id',            'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_event_loss_tables',        'fk_contract_event_loss_tables_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_large_loss_report',        'fk_contract_large_loss_report_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_loss_participation',       'fk_contract_loss_participation_contract_id',   'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_details',               'fk_contract_np_details_contract_id',           'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_egnpi_year',            'fk_contract_np_egnpi_year_contract_id',        'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_expiring_layers',       'fk_contract_np_expiring_layers_contract_id',   'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_expiring_terms',        'fk_contract_np_expiring_terms_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_layers',                'fk_contract_np_layers_contract_id',            'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_pricing_inputs',        'fk_contract_np_pricing_inputs_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_pricing_layer_inputs',  'fk_contract_np_pricing_layer_inputs_contract_id','contract_id','contract','contract_id');
SELECT public._add_fk_if_missing('contract_np_pricing_outputs',       'fk_contract_np_pricing_outputs_contract_id',   'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_terms',                 'fk_contract_np_terms_contract_id',             'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_offer',                    'fk_contract_offer_contract_id',                'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_pricing_outputs',          'fk_contract_pricing_outputs_contract_id',      'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_pricing_patterns',         'fk_contract_pricing_patterns_contract_id',     'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_pricing_yearly',           'fk_contract_pricing_yearly_contract_id',       'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_prop_details',             'fk_contract_prop_details_contract_id',         'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_risk_profile',             'fk_contract_risk_profile_contract_id',         'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_straight_experience',      'fk_contract_straight_experience_contract_id',  'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_straight_uw_stats',        'fk_contract_straight_uw_stats_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_terms_snapshot',           'fk_contract_terms_snapshot_contract_id',       'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_triangle_cells',           'fk_contract_triangle_cells_contract_id',       'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_underwriting_limit',       'fk_contract_underwriting_limit_contract_id',   'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_workflow_event',           'fk_contract_workflow_event_contract_id',       'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_excess_ldf',            'fk_contract_np_excess_ldf_contract_id',        'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_large_loss_ldf',        'fk_contract_np_large_loss_ldf_contract_id',    'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_cat_loss_ldf',          'fk_contract_np_cat_loss_ldf_contract_id',      'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_large_loss_ultimate',   'fk_contract_np_large_loss_ultimate_contract_id','contract_id','contract','contract_id');
SELECT public._add_fk_if_missing('contract_np_cat_loss_ultimate',     'fk_contract_np_cat_loss_ultimate_contract_id', 'contract_id', 'contract', 'contract_id');
SELECT public._add_fk_if_missing('contract_np_historical_performance','fk_contract_np_historical_performance_contract_id','contract_id','contract','contract_id');

-- ─── Quote children (ON DELETE CASCADE) ────────────────────────────
SELECT public._add_fk_if_missing('quote_cat_loss_report',             'fk_quote_cat_loss_report_quote_id',            'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_cedant_exposure',             'fk_quote_cedant_exposure_quote_id',            'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_claims_profile',              'fk_quote_claims_profile_quote_id',             'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_class_of_business',           'fk_quote_class_of_business_quote_id',          'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_commission_slides',           'fk_quote_commission_slides_quote_id',          'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_commissions',                 'fk_quote_commissions_quote_id',                'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_cresta_data',                 'fk_quote_cresta_data_quote_id',                'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_dev_factor',                  'fk_quote_dev_factor_quote_id',                 'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_epi_split',                   'fk_quote_epi_split_quote_id',                  'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_large_loss_report',           'fk_quote_large_loss_report_quote_id',          'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_loss_participation',          'fk_quote_loss_participation_quote_id',         'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_details',                  'fk_quote_np_details_quote_id',                 'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_egnpi_year',               'fk_quote_np_egnpi_year_quote_id',              'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_expiring_layers',          'fk_quote_np_expiring_layers_quote_id',         'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_expiring_terms',           'fk_quote_np_expiring_terms_quote_id',          'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_layers',                   'fk_quote_np_layers_quote_id',                  'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_pricing_inputs',           'fk_quote_np_pricing_inputs_quote_id',          'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_pricing_layer_inputs',     'fk_quote_np_pricing_layer_inputs_quote_id',    'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_pricing_outputs',          'fk_quote_np_pricing_outputs_quote_id',         'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_terms',                    'fk_quote_np_terms_quote_id',                   'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_offer',                       'fk_quote_offer_quote_id',                      'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_pricing_outputs',             'fk_quote_pricing_outputs_quote_id',            'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_pricing_yearly',              'fk_quote_pricing_yearly_quote_id',             'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_prop_details',                'fk_quote_prop_details_quote_id',               'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_risk_profile',                'fk_quote_risk_profile_quote_id',               'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_triangle_cells',              'fk_quote_triangle_cells_quote_id',             'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_underwriting_limit',          'fk_quote_underwriting_limit_quote_id',         'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_excess_ldf',               'fk_quote_np_excess_ldf_quote_id',              'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_large_loss_ldf',           'fk_quote_np_large_loss_ldf_quote_id',          'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_cat_loss_ldf',             'fk_quote_np_cat_loss_ldf_quote_id',            'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_large_loss_ultimate',      'fk_quote_np_large_loss_ultimate_quote_id',     'quote_id', 'quote', 'quote_id');
SELECT public._add_fk_if_missing('quote_np_cat_loss_ultimate',        'fk_quote_np_cat_loss_ultimate_quote_id',       'quote_id', 'quote', 'quote_id');

-- ─── Second-level children (band/item/layer tables) ───────────────
-- These FK their parent domain entity, not the contract/quote directly.
SELECT public._add_fk_if_missing('contract_claims_profile_band',      'fk_contract_claims_profile_band_profile_id',   'profile_id', 'contract_claims_profile', 'profile_id');
SELECT public._add_fk_if_missing('contract_risk_profile_band',        'fk_contract_risk_profile_band_profile_id',     'profile_id', 'contract_risk_profile',   'profile_id');
SELECT public._add_fk_if_missing('quote_claims_profile_band',         'fk_quote_claims_profile_band_profile_id',      'profile_id', 'quote_claims_profile',    'profile_id');
SELECT public._add_fk_if_missing('quote_risk_profile_band',           'fk_quote_risk_profile_band_profile_id',        'profile_id', 'quote_risk_profile',      'profile_id');
SELECT public._add_fk_if_missing('contract_large_losses',             'fk_contract_large_losses_report_id',           'report_id',  'contract_large_loss_report', 'report_id');
SELECT public._add_fk_if_missing('contract_cat_losses',               'fk_contract_cat_losses_report_id',             'report_id',  'contract_cat_loss_report',   'report_id');
SELECT public._add_fk_if_missing('contract_np_layer_class_of_business','fk_contract_np_layer_cob_layer_id',           'layer_id',   'contract_np_layers',      'layer_id');

-- ─── Reference FKs (ON DELETE RESTRICT — master data is shared) ────
-- Deliberately RESTRICT: a cedant/broker/country with live contracts
-- must not be silently nulled or cascade-deleted.
SELECT public._add_fk_if_missing('contract', 'fk_contract_cedant_id',  'cedant_id',  'companies', 'company_id', 'RESTRICT');
SELECT public._add_fk_if_missing('contract', 'fk_contract_broker_id',  'broker_id',  'brokers',   'broker_id',  'RESTRICT');
SELECT public._add_fk_if_missing('contract', 'fk_contract_country_id', 'country_id', 'country',   'country_id', 'RESTRICT');
SELECT public._add_fk_if_missing('quote',    'fk_quote_cedant_id',     'cedant_id',  'companies', 'company_id', 'RESTRICT');
SELECT public._add_fk_if_missing('quote',    'fk_quote_broker_id',     'broker_id',  'brokers',   'broker_id',  'RESTRICT');
SELECT public._add_fk_if_missing('quote',    'fk_quote_country_id',    'country_id', 'country',   'country_id', 'RESTRICT');

-- ─── Reference list items ─────────────────────────────────────────
SELECT public._add_fk_if_missing('ref_list_item', 'fk_ref_list_item_list_id', 'list_id', 'ref_list', 'list_id', 'CASCADE');

-- Helper fn is left in place; other migrations can use it if they
-- need the same "add FK if missing" semantics.
