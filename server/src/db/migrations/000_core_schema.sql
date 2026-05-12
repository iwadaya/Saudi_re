-- 000_core_schema.sql
-- Auto-generated from production dump. Single source of truth.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

CREATE TYPE public.commission_mode AS ENUM (
    'FIXED',
    'SLIDING'
);

CREATE TYPE public.contract_status AS ENUM (
    'DRAFT',
    'QUOTED',
    'AWAITING_APPROVAL',
    'BOUND',
    'RENEWED',
    'CANCELLED',
    'AWAITING_SIGNED_LINE',
    'OFFERED',
    'DECLINED',
    'SIGNED',
    'NTU'
);

CREATE TYPE public.triangle_type AS ENUM (
    'PREMIUM',
    'CLAIMS_PAID',
    'CLAIMS_OS',
    'INCURRED'
);

CREATE TYPE public.uw_workflow_status AS ENUM (
    'DRAFT',
    'WAITING_APPROVAL',
    'APPROVED',
    'AWAITING_SIGNED_LINE',
    'SIGNED',
    'NTU',
    'DECLINED'
);

CREATE TABLE IF NOT EXISTS public.approval_decision (
    decision_id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    decided_by uuid NOT NULL,
    decided_by_role uuid,
    decision text NOT NULL,
    comment text,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_decision_decision_check CHECK ((decision = ANY (ARRAY['APPROVED'::text, 'DECLINED'::text, 'RETURNED'::text])))
);

CREATE TABLE IF NOT EXISTS public.approval_request (
    request_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    submitted_by uuid NOT NULL,
    limit_usd numeric(18,2),
    status text DEFAULT 'PENDING'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT approval_request_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'DECLINED'::text, 'RETURNED'::text])))
);

CREATE TABLE IF NOT EXISTS public.audit_log (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    event_type text NOT NULL,
    actor text DEFAULT 'SYSTEM'::text NOT NULL,
    payload jsonb,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.brokers (
    broker_id uuid DEFAULT gen_random_uuid() NOT NULL,
    broker_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.class_of_business (
    class_of_business_id uuid DEFAULT gen_random_uuid() NOT NULL,
    class_of_business text NOT NULL,
    code text
);

CREATE TABLE IF NOT EXISTS public.companies (
    company_id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_name text NOT NULL,
    country_id uuid
);

CREATE TABLE IF NOT EXISTS public.contract (
    contract_id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_contract_id uuid,
    cedant_id uuid,
    broker_id uuid,
    country_id uuid,
    currency_id uuid,
    treaty_type_id uuid,
    uw_year integer NOT NULL,
    status public.contract_status DEFAULT 'DRAFT'::public.contract_status,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    decline_reason text,
    experience_source text DEFAULT 'TRIANGLE'::text,
    contract_group_id uuid,
    uw_status public.uw_workflow_status DEFAULT 'DRAFT'::public.uw_workflow_status NOT NULL,
    signed_line_pct numeric(9,6),
    signed_at timestamp with time zone,
    ntu_reason text,
    ntu_at timestamp with time zone,
    declined_at timestamp with time zone,
    renewal_date date,
    primary_class_of_business_id uuid,
    created_by_user_id uuid,
    assigned_to_user_id uuid,
    inception_date date,
    contract_description text,
    CONSTRAINT contract_experience_source_check CHECK ((experience_source = ANY (ARRAY['TRIANGLE'::text, 'STRAIGHT'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_approval (
    approval_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    requested_by text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decision text,
    decided_by text,
    decided_at timestamp with time zone,
    note text,
    CONSTRAINT contract_approval_decision_check CHECK ((decision = ANY (ARRAY['APPROVED'::text, 'DECLINED'::text, 'RETURNED'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_assignment_history (
    assignment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    from_user_id uuid,
    to_user_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    assignment_type text NOT NULL,
    comment text,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_assignment_history_assignment_type_check CHECK ((assignment_type = ANY (ARRAY['CREATED'::text, 'SELF_ASSIGNED'::text, 'REASSIGNED'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_audit_event (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    event_type text NOT NULL,
    actor text,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_cat_loss_report (
    report_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid,
    report_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    quote_id uuid
);

CREATE TABLE IF NOT EXISTS public.contract_cat_losses (
    loss_id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    uw_year integer,
    insured_name text,
    loss_name text,
    date_of_loss timestamp with time zone,
    class_of_business text,
    paid numeric(18,2) DEFAULT 0,
    os numeric(18,2) DEFAULT 0,
    incurred numeric(18,2) DEFAULT 0,
    is_selected boolean DEFAULT true,
    inflation_factor numeric(10,4) DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_claims_profile (
    profile_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_claims_profile_band (
    band_id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    from_amt numeric(18,2),
    to_amt numeric(18,2),
    no_of_claims numeric(18,2),
    aggregate_incurred numeric(18,2),
    no_of_risks numeric(18,2) DEFAULT 0,
    total_sum_insured numeric(18,2) DEFAULT 0,
    gross_premium numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_class_of_business (
    contract_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_commission_slides (
    contract_id uuid NOT NULL,
    row_no integer NOT NULL,
    loss_ratio_pct numeric,
    commission_pct numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_commissions (
    commission_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    mode public.commission_mode DEFAULT 'FIXED'::public.commission_mode,
    fixed_commission_pct numeric(5,2),
    sliding_min_loss_ratio numeric(5,2),
    sliding_max_loss_ratio numeric(5,2),
    sliding_min_commission numeric(5,2),
    sliding_max_commission numeric(5,2),
    mgmt_expenses_pct numeric(5,2),
    profit_commission_pct numeric(5,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    fixed_commission_qs_pct numeric(5,2),
    fixed_commission_surplus_pct numeric(5,2),
    provisional_commission_pct numeric(5,2)
);

CREATE TABLE IF NOT EXISTS public.contract_cresta_data (
    cresta_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    country_id uuid NOT NULL,
    zone_id text,
    zone_name text,
    eq_agg numeric(18,2) DEFAULT 0,
    ws_agg numeric(18,2) DEFAULT 0,
    flood_agg numeric(18,2) DEFAULT 0,
    srcc_agg numeric(18,2) DEFAULT 0,
    others_agg numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    treaty_type text DEFAULT 'Both'::text,
    cob_id uuid,
    cob_name text,
    residential_bldg_pct numeric(6,2) DEFAULT 30,
    commercial_bldg_pct numeric(6,2) DEFAULT 25,
    commercial_cont_pct numeric(6,2) DEFAULT 15,
    industrial_bldg_pct numeric(6,2) DEFAULT 20,
    industrial_cont_pct numeric(6,2) DEFAULT 10
);

CREATE TABLE IF NOT EXISTS public.contract_dev_factor (
    contract_id uuid NOT NULL,
    triangle_type text NOT NULL,
    dev_month integer NOT NULL,
    selected_ldf numeric(12,6),
    selected_cdf numeric(12,6),
    created_at timestamp without time zone DEFAULT now(),
    actual_ldf numeric,
    actual_cdf numeric,
    param_ldf numeric,
    param_cdf numeric,
    chosen_source text,
    chosen_ldf numeric,
    chosen_cdf numeric,
    overridden boolean DEFAULT false,
    parametrized_ldf numeric,
    parametrized_cdf numeric
);

CREATE TABLE IF NOT EXISTS public.contract_document (
    document_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    file_name text NOT NULL,
    mime_type text,
    size_bytes bigint,
    storage_path text,
    description text,
    uploaded_at timestamp with time zone DEFAULT now(),
    quote_id uuid,
    doc_type text,
    title text
);

CREATE TABLE IF NOT EXISTS public.contract_epi_split (
    contract_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    premium numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_event_loss_tables (
    contract_id uuid NOT NULL,
    elt_data jsonb,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_group (
    contract_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
    cedant_id uuid NOT NULL,
    uw_year integer NOT NULL,
    program_name text NOT NULL,
    currency_id uuid,
    inception_date date,
    expiry_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_large_loss_report (
    report_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid,
    report_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    quote_id uuid
);

CREATE TABLE IF NOT EXISTS public.contract_large_losses (
    loss_id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    uw_year integer,
    insured_name text,
    loss_name text,
    date_of_loss timestamp with time zone,
    class_of_business text,
    paid numeric(18,2) DEFAULT 0,
    os numeric(18,2) DEFAULT 0,
    incurred numeric(18,2) DEFAULT 0,
    is_selected boolean DEFAULT true,
    inflation_factor numeric(10,4) DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_loss_participation (
    lp_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    enabled boolean DEFAULT false,
    min_loss_ratio_pct numeric(5,2),
    max_loss_ratio_pct numeric(5,2),
    reinsurer_share_pct numeric(5,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_loss_selection_snapshot (
    snapshot_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid,
    loss_type text NOT NULL,
    inflation_mode text,
    inflation_index text,
    inflation_base_year integer,
    inflation_to_year integer,
    global_factor numeric,
    selected_count integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    return_period_curve jsonb,
    return_period_key_points jsonb,
    assumptions_hash text,
    updated_at timestamp with time zone DEFAULT now(),
    inflation_rate_pct numeric(8,4),
    threshold numeric(18,2),
    loadings jsonb,
    total_loading_pct numeric(8,4),
    distribution_fits jsonb,
    active_distribution text,
    pareto_xm numeric(18,2),
    pareto_alpha numeric(12,6),
    pareto_limit numeric(18,2),
    observation_years numeric(6,1),
    quote_id uuid,
    CONSTRAINT chk_loss_sel_snap_owner CHECK (((contract_id IS NOT NULL) OR (quote_id IS NOT NULL))),
    CONSTRAINT contract_loss_selection_snapshot_loss_type_check CHECK ((loss_type = ANY (ARRAY['LARGE'::text, 'CAT'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_loss_selection_snapshot_item (
    snapshot_item_id uuid DEFAULT gen_random_uuid() NOT NULL,
    snapshot_id uuid NOT NULL,
    uw_year integer,
    insured_name text,
    loss_name text,
    date_of_loss date,
    class_of_business text,
    paid numeric,
    os numeric,
    incurred numeric,
    inflation_factor numeric NOT NULL,
    inflated_incurred numeric,
    source_loss_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_np_details (
    detail_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    number_of_layers integer DEFAULT 1 NOT NULL,
    deductible numeric(18,2),
    max_retention numeric(18,2),
    accounting_method text,
    xl_type text,
    accounts text,
    brokerage_pct numeric(5,2),
    no_claims_bonus_pct numeric(5,2),
    profit_commission_pct numeric(5,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    est_gnpi numeric(18,2),
    adjustment_rate numeric(10,6),
    deposit_premium numeric(18,2),
    expiring_number_of_layers integer,
    experience_start_year integer,
    taxes_pct numeric
);

CREATE TABLE IF NOT EXISTS public.contract_np_egnpi_year (
    egnpi_year_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    uw_year integer NOT NULL,
    egnpi numeric(18,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    inflation_pct numeric(9,6)
);

CREATE TABLE IF NOT EXISTS public.contract_np_expiring_layers (
    expiring_layer_id integer NOT NULL,
    contract_id uuid NOT NULL,
    layer_number integer NOT NULL,
    attachment numeric,
    layer_limit numeric,
    aggregate_limit numeric,
    egnpi numeric,
    earned_premium numeric,
    rate numeric,
    rol numeric,
    num_reinstatements integer,
    reinstatement_pct numeric,
    annual_agg_deductible numeric,
    peril_scope text DEFAULT 'BOTH'::text NOT NULL,
    mdp numeric,
    mdp_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_np_expiring_terms (
    id integer NOT NULL,
    contract_id uuid NOT NULL,
    egnpi numeric,
    deductible numeric,
    risk_limit numeric,
    cat_limit numeric,
    brokerage_pct numeric,
    no_claims_bonus_pct numeric,
    profit_commission_pct numeric,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    covered_props jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.contract_np_layer_class_of_business (
    layer_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contract_np_layers (
    layer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    layer_number integer NOT NULL,
    attachment numeric(18,2),
    layer_limit numeric(18,2),
    aggregate_limit numeric(18,2),
    egnpi numeric(18,2),
    earned_premium numeric(18,2),
    rate numeric(12,8),
    rol numeric(12,8),
    num_reinstatements integer,
    reinstatement_pct numeric(5,2),
    annual_agg_deductible numeric(18,2),
    peril_scope text DEFAULT 'RISK'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    mdp numeric,
    mdp_pct numeric,
    CONSTRAINT contract_np_layers_peril_scope_check CHECK ((peril_scope = ANY (ARRAY['RISK'::text, 'CAT'::text, 'BOTH'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_np_pricing_inputs (
    contract_id uuid NOT NULL,
    burn_weight_pct numeric,
    exposure_weight_pct numeric,
    pricing_loading_pct numeric,
    swiss_re_curve_name text,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_np_pricing_layer_inputs (
    contract_id uuid NOT NULL,
    layer_number integer NOT NULL,
    expiring_pricing_pct numeric,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_np_pricing_outputs (
    contract_id uuid NOT NULL,
    layer_number integer NOT NULL,
    section text NOT NULL,
    pure_burning_cost numeric,
    pareto_pricing numeric,
    burn_plus_pareto numeric,
    exposure_rating numeric,
    burn_weight_pct numeric,
    exposure_weight_pct numeric,
    pricing_loading_pct numeric,
    total_price numeric,
    prob_attach numeric,
    prob_exhaust numeric,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contract_np_pricing_outputs_section_check CHECK ((section = ANY (ARRAY['RISK'::text, 'CAT'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_np_terms (
    terms_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    terms jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_offer (
    offer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    written_line_pct numeric(9,6),
    premium_driver text,
    profit_driver text,
    strategic_rationale text,
    tactical_rationale text,
    next_approver text,
    status text DEFAULT 'PENDING'::text,
    created_at timestamp without time zone DEFAULT now(),
    approved_at timestamp with time zone,
    sent_to_market_at timestamp with time zone,
    signed_at timestamp with time zone,
    ntu_at timestamp with time zone,
    declined_at timestamp with time zone,
    ntu_reason text,
    decline_reason text
);

CREATE TABLE IF NOT EXISTS public.contract_offer_layer (
    offer_id uuid NOT NULL,
    layer_number integer NOT NULL,
    offered_share_pct numeric(9,6) DEFAULT 0 NOT NULL,
    offered_premium numeric(18,2),
    risk_limit numeric(18,2),
    cat_limit numeric(18,2),
    agg_limit numeric(18,2)
);

CREATE TABLE IF NOT EXISTS public.contract_pricing_outputs (
    output_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    epi numeric(20,2),
    attritional_ratio numeric(12,8),
    large_loss_load numeric(12,8),
    cat_loss_load numeric(12,8),
    commission_ratio numeric(12,8),
    brokerage_ratio numeric(12,8),
    tax_ratio numeric(12,8),
    technical_result numeric(12,8),
    max_commission numeric(12,8),
    target_margin numeric(12,8),
    updated_at timestamp without time zone DEFAULT now(),
    uw_comment text,
    offer_status text,
    offer_line text,
    offer_comment text,
    offer_approver text,
    signed_line_pct numeric
);

CREATE TABLE IF NOT EXISTS public.contract_pricing_patterns (
    pattern_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    triangle_type text NOT NULL,
    selection_method text DEFAULT 'WEIGHTED'::text,
    selected_factors jsonb,
    tail_factor numeric(10,4) DEFAULT 1.0000,
    bf_ielr numeric(10,4) DEFAULT 0.0000,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_pricing_yearly (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    uw_year integer NOT NULL,
    ultimate_premium numeric(20,2),
    ultimate_loss numeric(20,2),
    loss_ratio numeric(12,8),
    commission_amt numeric(20,2),
    brokerage_amt numeric(20,2),
    technical_result numeric(20,2),
    record_type text DEFAULT 'PROJECTED'::text NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_prop_details (
    detail_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    triangulations_available boolean DEFAULT true,
    renewal_date date,
    qs_limit numeric(18,2),
    retention_pct numeric(5,2),
    retention_amt numeric(18,2),
    cession_pct numeric(5,2),
    cession_amt numeric(18,2),
    surplus_max_retention numeric(18,2),
    num_lines numeric(10,2),
    total_capacity numeric(18,2),
    event_limit numeric(18,2),
    aal numeric(18,2),
    quota_share_epi numeric(18,2),
    surplus_epi numeric(18,2),
    brokerage_pct numeric(5,2),
    taxes_pct numeric(5,2),
    loss_cap_pct numeric(5,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    inception_date date,
    experience_start_year integer
);

CREATE TABLE IF NOT EXISTS public.contract_risk_profile (
    profile_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    c_value numeric(10,4) DEFAULT 0,
    pml_percentage numeric(5,2) DEFAULT 0,
    selected_curve text,
    custom_b numeric(12,6),
    custom_g numeric(12,6)
);

CREATE TABLE IF NOT EXISTS public.contract_risk_profile_band (
    band_id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    from_amt numeric(18,2),
    to_amt numeric(18,2),
    no_of_risks numeric(18,2),
    total_sum_insured numeric(18,2),
    gross_premium numeric(18,2),
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_straight_experience (
    exp_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    tail_type text DEFAULT 'SHORT_TAIL'::text,
    uw_start_year integer,
    uw_end_year integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contract_straight_experience_tail_type_check CHECK ((tail_type = ANY (ARRAY['SHORT_TAIL'::text, 'LONG_TAIL'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_straight_uw_stats (
    stat_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    underwriting_year integer NOT NULL,
    premium numeric(18,2) DEFAULT 0,
    paid_claims numeric(18,2) DEFAULT 0,
    os_claims numeric(18,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.contract_terms_snapshot (
    snapshot_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    terms_kind text NOT NULL,
    terms jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contract_terms_snapshot_terms_kind_check CHECK ((terms_kind = ANY (ARRAY['PROP'::text, 'NP'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_triangle_cells (
    cell_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    type public.triangle_type NOT NULL,
    origin_year integer NOT NULL,
    dev_months integer NOT NULL,
    cum_value numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contract_underwriting_limit (
    contract_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    limit_amount numeric(18,2) DEFAULT 0 NOT NULL,
    basis text DEFAULT 'COMBINED'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT contract_uw_limit_basis_check CHECK ((basis = ANY (ARRAY['COMBINED'::text, 'RISK'::text, 'CAT'::text])))
);

CREATE TABLE IF NOT EXISTS public.contract_workflow_event (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor text,
    comment text,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.country (
    country_id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_code text NOT NULL,
    country_name text NOT NULL,
    region text
);

CREATE TABLE IF NOT EXISTS public.currency (
    currency_id uuid DEFAULT gen_random_uuid() NOT NULL,
    currency_code text NOT NULL,
    currency_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_brokers (
    id integer NOT NULL,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_cedants (
    id integer NOT NULL,
    name text NOT NULL,
    country_id integer
);

CREATE TABLE IF NOT EXISTS public.pd_contract_metrics (
    id integer NOT NULL,
    contract_id integer NOT NULL,
    model_run_id integer NOT NULL,
    modelled_lr numeric(12,6),
    modelled_uw_margin numeric(12,6),
    i_re_lr numeric(12,6),
    i_re_uw_margin numeric(12,6)
);

CREATE TABLE IF NOT EXISTS public.pd_contract_terms (
    id integer NOT NULL,
    contract_id integer NOT NULL,
    currency_id integer,
    exchange_rate numeric(18,6),
    epi_original numeric(20,2),
    capacity_original numeric(20,2),
    epi_100_zar numeric(20,2),
    capacity_100_zar numeric(20,2),
    santam_re_pct numeric(12,6),
    santam_re_epi_zar numeric(20,2),
    santam_re_exp_zar numeric(20,2),
    fronting text,
    fronted_company_name text,
    fronted_share numeric(12,6),
    retro_qs text,
    other_outwards_retro text,
    total_cost_of_cover numeric(20,2)
);

CREATE TABLE IF NOT EXISTS public.pd_contracts (
    id integer NOT NULL,
    source_key text NOT NULL,
    uw_year integer,
    month text,
    cedant_id integer,
    broker_id integer,
    country_id integer,
    region_id integer,
    lob_id integer,
    nature_of_contract text,
    contract_description text
);

CREATE TABLE IF NOT EXISTS public.pd_countries (
    id integer NOT NULL,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_currencies (
    id integer NOT NULL,
    code text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_lobs (
    id integer NOT NULL,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_model_runs (
    id integer NOT NULL,
    name text DEFAULT 'default'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_regions (
    id integer NOT NULL,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pd_stg_all_contracts (
    id integer NOT NULL,
    uw_year integer,
    check_code text,
    month text,
    group_vs_ng text,
    new_renewal text,
    cedant_name text,
    country_of_origin text,
    geographical_region text,
    nature_of_contract text,
    contract_description text,
    line_of_business text,
    broker text,
    currency text,
    exchange_rate numeric(18,6),
    epi_original numeric(20,2),
    capacity_original numeric(20,2),
    epi_100_zar numeric(20,2),
    capacity_100_zar numeric(20,2),
    santam_re_pct numeric(12,6),
    santam_re_epi_zar numeric(20,2),
    santam_re_exp_zar numeric(20,2),
    first_month_in_revenue_report text,
    modelled_lr numeric(12,6),
    modelled_uw_margin numeric(12,6),
    i_re_lr numeric(12,6),
    i_re_uw_margin numeric(12,6),
    loaded_on_ire text,
    munich_re text,
    met text,
    offices text,
    unlimited text,
    fronting text,
    fronted_company_name text,
    fronted_share numeric(12,6),
    retro_qs text,
    other_outwards_retro text,
    total_cost_of_cover numeric(20,2),
    rol_1 numeric(12,6),
    premium_band text,
    exposure_band text,
    rol_2 numeric(12,6),
    balance numeric(20,2),
    balance_range text,
    written_lines text,
    number text,
    exposure_band_2 text
);

CREATE TABLE IF NOT EXISTS public.pricing_component_snapshots (
    id integer NOT NULL,
    contract_id uuid NOT NULL,
    snapshot_date timestamp without time zone DEFAULT now(),
    snapshot_label text,
    components jsonb NOT NULL,
    created_by text
);

CREATE TABLE IF NOT EXISTS public.pricing_components (
    pricing_component_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_id uuid NOT NULL,
    component_name text NOT NULL,
    actuarial_value text,
    uw_value text,
    market_value text,
    actual_stats_value text,
    comment text,
    created_at timestamp with time zone DEFAULT now(),
    exposure_value text
);

CREATE TABLE IF NOT EXISTS public.pricing_leads (
    contract_id uuid NOT NULL,
    lead_reinsurer text,
    expiring_reinsurer text,
    lead_share_pct numeric(5,2),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pricing_share_scenarios (
    contract_id uuid NOT NULL,
    share_label text NOT NULL,
    limit_amt numeric,
    premium_amt numeric,
    cedant_limit numeric,
    agg_contrib numeric,
    country_agg numeric,
    event_limit numeric,
    downside_amt numeric,
    shortfall_amt numeric,
    updated_at timestamp without time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote (
    quote_id uuid DEFAULT gen_random_uuid() NOT NULL,
    cedant_id uuid,
    broker_id uuid,
    country_id uuid,
    currency_id uuid,
    treaty_type_id uuid,
    uw_year integer,
    status text DEFAULT 'DRAFT'::text,
    experience_source text,
    renewal_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by_user_id uuid,
    assigned_to_user_id uuid,
    inception_date date,
    decline_reason text,
    uw_status text DEFAULT 'DRAFT'::text,
    signed_line_pct numeric(9,6),
    signed_at timestamp with time zone,
    ntu_reason text,
    ntu_at timestamp with time zone,
    declined_at timestamp with time zone,
    primary_class_of_business_id uuid,
    contract_description text,
    next_approver text
);

CREATE TABLE IF NOT EXISTS public.quote_cat_loss_report (
    quote_id uuid NOT NULL,
    report_data jsonb,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_cedant_exposure (
    quote_id uuid NOT NULL,
    exposure_json jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_claims_profile (
    profile_id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_claims_profile_band (
    band_id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    from_amt numeric(18,2) DEFAULT 0,
    to_amt numeric(18,2) DEFAULT 0,
    no_of_risks integer DEFAULT 0,
    total_sum_insured numeric(18,2) DEFAULT 0,
    gross_premium numeric(18,2) DEFAULT 0,
    no_of_claims integer DEFAULT 0,
    aggregate_incurred numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_class_of_business (
    quote_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_commission_slides (
    quote_id uuid NOT NULL,
    row_no integer NOT NULL,
    loss_ratio_pct numeric,
    commission_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_commissions (
    quote_id uuid NOT NULL,
    mode text,
    fixed_commission_pct numeric,
    fixed_commission_qs_pct numeric,
    fixed_commission_surplus_pct numeric,
    sliding_min_loss_ratio numeric,
    sliding_max_loss_ratio numeric,
    sliding_min_commission numeric,
    sliding_max_commission numeric,
    mgmt_expenses_pct numeric,
    profit_commission_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    provisional_commission_pct numeric(5,2)
);

CREATE TABLE IF NOT EXISTS public.quote_cresta_data (
    cresta_id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    country_id uuid,
    zone_id text,
    zone_name text,
    eq_agg numeric(18,2) DEFAULT 0,
    ws_agg numeric(18,2) DEFAULT 0,
    flood_agg numeric(18,2) DEFAULT 0,
    srcc_agg numeric(18,2) DEFAULT 0,
    others_agg numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    treaty_type text DEFAULT 'Both'::text,
    cob_id uuid,
    cob_name text,
    residential_bldg_pct numeric(6,2) DEFAULT 30,
    commercial_bldg_pct numeric(6,2) DEFAULT 25,
    commercial_cont_pct numeric(6,2) DEFAULT 15,
    industrial_bldg_pct numeric(6,2) DEFAULT 20,
    industrial_cont_pct numeric(6,2) DEFAULT 10
);

CREATE TABLE IF NOT EXISTS public.quote_dev_factor (
    quote_id uuid NOT NULL,
    triangle_type text NOT NULL,
    dev_month integer NOT NULL,
    selected_ldf numeric(12,6),
    selected_cdf numeric(12,6),
    created_at timestamp with time zone DEFAULT now(),
    actual_ldf numeric,
    actual_cdf numeric,
    param_ldf numeric,
    param_cdf numeric,
    chosen_source text,
    chosen_ldf numeric,
    chosen_cdf numeric,
    overridden boolean DEFAULT false,
    parametrized_ldf numeric,
    parametrized_cdf numeric
);

CREATE TABLE IF NOT EXISTS public.quote_epi_split (
    quote_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    premium numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.quote_large_loss_report (
    quote_id uuid NOT NULL,
    report_data jsonb,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_loss_participation (
    quote_id uuid NOT NULL,
    enabled boolean DEFAULT false,
    min_loss_ratio_pct numeric,
    max_loss_ratio_pct numeric,
    reinsurer_share_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_np_details (
    quote_id uuid NOT NULL,
    number_of_layers integer,
    deductible numeric,
    max_retention numeric,
    accounting_method text,
    xl_type text,
    accounts text,
    brokerage_pct numeric,
    no_claims_bonus_pct numeric,
    profit_commission_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    est_gnpi numeric(18,2),
    adjustment_rate numeric(10,6),
    deposit_premium numeric(18,2),
    structures_to_quote integer,
    expiring_number_of_layers integer,
    experience_start_year integer,
    taxes_pct numeric
);

CREATE TABLE IF NOT EXISTS public.quote_np_egnpi_year (
    egnpi_year_id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    uw_year integer NOT NULL,
    egnpi numeric(18,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_np_expiring_layers (
    expiring_layer_id integer NOT NULL,
    quote_id uuid NOT NULL,
    layer_number integer NOT NULL,
    attachment numeric,
    layer_limit numeric,
    aggregate_limit numeric,
    egnpi numeric,
    earned_premium numeric,
    rate numeric,
    rol numeric,
    num_reinstatements integer,
    reinstatement_pct numeric,
    annual_agg_deductible numeric,
    peril_scope text DEFAULT 'BOTH'::text NOT NULL,
    mdp numeric,
    mdp_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_np_expiring_terms (
    id integer NOT NULL,
    quote_id uuid NOT NULL,
    egnpi numeric,
    deductible numeric,
    risk_limit numeric,
    cat_limit numeric,
    brokerage_pct numeric,
    no_claims_bonus_pct numeric,
    profit_commission_pct numeric,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    covered_props jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS public.quote_np_layers (
    quote_id uuid NOT NULL,
    layer_number integer NOT NULL,
    rate numeric,
    mdp numeric,
    mdp_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    attachment numeric(18,2),
    layer_limit numeric(18,2),
    aggregate_limit numeric(18,2),
    egnpi numeric(18,2),
    earned_premium numeric(18,2),
    rol numeric(12,8),
    num_reinstatements integer,
    reinstatement_pct numeric(5,2),
    annual_agg_deductible numeric(18,2),
    peril_scope text DEFAULT 'BOTH'::text
);

CREATE TABLE IF NOT EXISTS public.quote_np_pricing_inputs (
    quote_id uuid NOT NULL,
    burn_weight_pct numeric(10,4),
    exposure_weight_pct numeric(10,4),
    pricing_loading_pct numeric(10,4),
    swiss_re_curve_name text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_np_pricing_layer_inputs (
    quote_id uuid NOT NULL,
    layer_number integer NOT NULL,
    expiring_pricing_pct numeric(10,4),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_np_pricing_outputs (
    quote_id uuid NOT NULL,
    layer_number integer NOT NULL,
    section text NOT NULL,
    pure_burning_cost numeric(18,6),
    pareto_pricing numeric(18,6),
    burn_plus_pareto numeric(18,6),
    exposure_rating numeric(18,6),
    burn_weight_pct numeric(10,4),
    exposure_weight_pct numeric(10,4),
    pricing_loading_pct numeric(10,4),
    total_price numeric(18,6),
    prob_attach numeric(10,6),
    prob_exhaust numeric(10,6),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_np_terms (
    quote_id uuid NOT NULL,
    terms jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_offer (
    quote_id uuid NOT NULL,
    offer_json jsonb,
    workflow_json jsonb,
    written_line_pct numeric(10,6),
    premium_driver text,
    profit_driver text,
    strategic_rationale text,
    tactical_rationale text,
    next_approver text,
    status text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_pricing_outputs (
    quote_id uuid NOT NULL,
    epi numeric(20,2),
    attritional_ratio numeric(12,8),
    large_loss_load numeric(12,8),
    cat_loss_load numeric(12,8),
    commission_ratio numeric(12,8),
    brokerage_ratio numeric(12,8),
    tax_ratio numeric(12,8),
    technical_result numeric(12,8),
    max_commission numeric(12,8),
    target_margin numeric(12,8),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_pricing_yearly (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    uw_year integer NOT NULL,
    ultimate_premium numeric(20,2),
    ultimate_loss numeric(20,2),
    loss_ratio numeric(12,8),
    commission_amt numeric(20,2),
    brokerage_amt numeric(20,2),
    technical_result numeric(20,2),
    record_type text DEFAULT 'PROJECTED'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_prop_details (
    quote_id uuid NOT NULL,
    triangulations_available boolean DEFAULT true,
    renewal_date date,
    qs_limit numeric,
    retention_pct numeric,
    retention_amt numeric,
    cession_pct numeric,
    cession_amt numeric,
    surplus_max_retention numeric,
    num_lines integer,
    total_capacity numeric,
    event_limit numeric,
    aal numeric,
    quota_share_epi numeric,
    surplus_epi numeric,
    brokerage_pct numeric,
    taxes_pct numeric,
    loss_cap_pct numeric,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    experience_start_year integer
);

CREATE TABLE IF NOT EXISTS public.quote_risk_profile (
    profile_id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    c_value numeric(18,6) DEFAULT 0,
    pml_percentage numeric(18,6) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_risk_profile_band (
    band_id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    from_amt numeric(18,2) DEFAULT 0,
    to_amt numeric(18,2) DEFAULT 0,
    no_of_risks integer DEFAULT 0,
    total_sum_insured numeric(18,2) DEFAULT 0,
    gross_premium numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_triangle_cells (
    cell_id uuid DEFAULT gen_random_uuid() NOT NULL,
    quote_id uuid NOT NULL,
    type public.triangle_type NOT NULL,
    origin_year integer NOT NULL,
    dev_months integer NOT NULL,
    cum_value numeric(18,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.quote_underwriting_limit (
    quote_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL,
    limit_amount numeric(18,2) DEFAULT 0 NOT NULL,
    basis text DEFAULT 'COMBINED'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ref_benchmark_ldf (
    benchmark_id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_id uuid,
    tail_type text,
    development_month integer NOT NULL,
    incurred_ldf numeric(10,5) DEFAULT 1.00000,
    premium_ldf numeric(10,5) DEFAULT 1.00000,
    CONSTRAINT ref_benchmark_ldf_tail_type_check CHECK ((tail_type = ANY (ARRAY['SHORT_TAIL'::text, 'LONG_TAIL'::text])))
);

CREATE TABLE IF NOT EXISTS public.ref_country_inflation (
    country_id uuid NOT NULL,
    uw_year integer NOT NULL,
    inflation_pct numeric(10,4),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'IMF_WEO'::text
);

CREATE TABLE IF NOT EXISTS public.ref_cresta_zone (
    zone_db_id uuid DEFAULT gen_random_uuid() NOT NULL,
    country_id uuid,
    zone_id text NOT NULL,
    zone_name text,
    sort_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.ref_exchange_rate (
    rate_id uuid DEFAULT gen_random_uuid() NOT NULL,
    currency_code text NOT NULL,
    rate_to_usd numeric(18,8) NOT NULL,
    effective_date date DEFAULT CURRENT_DATE NOT NULL,
    source text DEFAULT 'SEED'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ref_list (
    list_id uuid DEFAULT gen_random_uuid() NOT NULL,
    list_key text NOT NULL,
    label text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ref_list_item (
    item_id uuid DEFAULT gen_random_uuid() NOT NULL,
    list_id uuid NOT NULL,
    code text,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ref_swiss_re_curve (
    curve_name text NOT NULL,
    x numeric NOT NULL,
    y numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS public.reinsurers (
    reinsurer_id uuid DEFAULT gen_random_uuid() NOT NULL,
    reinsurer_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.treaty_type (
    treaty_type_id uuid DEFAULT gen_random_uuid() NOT NULL,
    treaty_type text NOT NULL,
    category text DEFAULT 'PROPORTIONAL'::text
);

CREATE TABLE IF NOT EXISTS public.uw_role (
    role_id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_name text NOT NULL,
    authority_limit_usd numeric(18,2),
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.uw_role_class_restriction (
    role_id uuid NOT NULL,
    class_of_business_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS public.uw_user (
    user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    role_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Primary key constraints
ALTER TABLE IF EXISTS public.approval_decision
    ADD CONSTRAINT approval_decision_pkey PRIMARY KEY (decision_id);
ALTER TABLE IF EXISTS public.approval_request
    ADD CONSTRAINT approval_request_pkey PRIMARY KEY (request_id);
ALTER TABLE IF EXISTS public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (event_id);
ALTER TABLE IF EXISTS public.brokers
    ADD CONSTRAINT brokers_pkey PRIMARY KEY (broker_id);
ALTER TABLE IF EXISTS public.class_of_business
    ADD CONSTRAINT class_of_business_pkey PRIMARY KEY (class_of_business_id);
ALTER TABLE IF EXISTS public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (company_id);
ALTER TABLE IF EXISTS public.contract_approval
    ADD CONSTRAINT contract_approval_pkey PRIMARY KEY (approval_id);
ALTER TABLE IF EXISTS public.contract_assignment_history
    ADD CONSTRAINT contract_assignment_history_pkey PRIMARY KEY (assignment_id);
ALTER TABLE IF EXISTS public.contract_audit_event
    ADD CONSTRAINT contract_audit_event_pkey PRIMARY KEY (event_id);
ALTER TABLE IF EXISTS public.contract_cat_loss_report
    ADD CONSTRAINT contract_cat_loss_report_pkey PRIMARY KEY (report_id);
ALTER TABLE IF EXISTS public.contract_cat_losses
    ADD CONSTRAINT contract_cat_losses_pkey PRIMARY KEY (loss_id);
ALTER TABLE IF EXISTS public.contract_claims_profile_band
    ADD CONSTRAINT contract_claims_profile_band_pkey PRIMARY KEY (band_id);
ALTER TABLE IF EXISTS public.contract_claims_profile
    ADD CONSTRAINT contract_claims_profile_pkey PRIMARY KEY (profile_id);
ALTER TABLE IF EXISTS public.contract_class_of_business
    ADD CONSTRAINT contract_class_of_business_pkey PRIMARY KEY (contract_id, class_of_business_id);
ALTER TABLE IF EXISTS public.contract_commission_slides
    ADD CONSTRAINT contract_commission_slides_pkey PRIMARY KEY (contract_id, row_no);
ALTER TABLE IF EXISTS public.contract_commissions
    ADD CONSTRAINT contract_commissions_pkey PRIMARY KEY (commission_id);
ALTER TABLE IF EXISTS public.contract_cresta_data
    ADD CONSTRAINT contract_cresta_data_pkey PRIMARY KEY (cresta_id);
ALTER TABLE IF EXISTS public.contract_dev_factor
    ADD CONSTRAINT contract_dev_factor_pkey PRIMARY KEY (contract_id, triangle_type, dev_month);
ALTER TABLE IF EXISTS public.contract_document
    ADD CONSTRAINT contract_document_pkey PRIMARY KEY (document_id);
ALTER TABLE IF EXISTS public.contract_epi_split
    ADD CONSTRAINT contract_epi_split_pkey PRIMARY KEY (contract_id, class_of_business_id);
ALTER TABLE IF EXISTS public.contract_event_loss_tables
    ADD CONSTRAINT contract_event_loss_tables_pkey PRIMARY KEY (contract_id);
ALTER TABLE IF EXISTS public.contract_group
    ADD CONSTRAINT contract_group_pkey PRIMARY KEY (contract_group_id);
ALTER TABLE IF EXISTS public.contract_large_loss_report
    ADD CONSTRAINT contract_large_loss_report_pkey PRIMARY KEY (report_id);
ALTER TABLE IF EXISTS public.contract_large_losses
    ADD CONSTRAINT contract_large_losses_pkey PRIMARY KEY (loss_id);
ALTER TABLE IF EXISTS public.contract_loss_participation
    ADD CONSTRAINT contract_loss_participation_pkey PRIMARY KEY (lp_id);
ALTER TABLE IF EXISTS public.contract_loss_selection_snapshot_item
    ADD CONSTRAINT contract_loss_selection_snapshot_item_pkey PRIMARY KEY (snapshot_item_id);
ALTER TABLE IF EXISTS public.contract_loss_selection_snapshot
    ADD CONSTRAINT contract_loss_selection_snapshot_pkey PRIMARY KEY (snapshot_id);
ALTER TABLE IF EXISTS public.contract_np_details
    ADD CONSTRAINT contract_np_details_pkey PRIMARY KEY (detail_id);
ALTER TABLE IF EXISTS public.contract_np_egnpi_year
    ADD CONSTRAINT contract_np_egnpi_year_pkey PRIMARY KEY (egnpi_year_id);
ALTER TABLE IF EXISTS public.contract_np_expiring_layers
    ADD CONSTRAINT contract_np_expiring_layers_pkey PRIMARY KEY (expiring_layer_id);
ALTER TABLE IF EXISTS public.contract_np_expiring_terms
    ADD CONSTRAINT contract_np_expiring_terms_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.contract_np_layer_class_of_business
    ADD CONSTRAINT contract_np_layer_cob_pkey PRIMARY KEY (layer_id, class_of_business_id);
ALTER TABLE IF EXISTS public.contract_np_layers
    ADD CONSTRAINT contract_np_layers_pkey PRIMARY KEY (layer_id);
ALTER TABLE IF EXISTS public.contract_np_pricing_inputs
    ADD CONSTRAINT contract_np_pricing_inputs_pkey PRIMARY KEY (contract_id);
ALTER TABLE IF EXISTS public.contract_np_pricing_layer_inputs
    ADD CONSTRAINT contract_np_pricing_layer_inputs_pkey PRIMARY KEY (contract_id, layer_number);
ALTER TABLE IF EXISTS public.contract_np_pricing_outputs
    ADD CONSTRAINT contract_np_pricing_outputs_pkey PRIMARY KEY (contract_id, layer_number, section);
ALTER TABLE IF EXISTS public.contract_np_terms
    ADD CONSTRAINT contract_np_terms_pkey PRIMARY KEY (terms_id);
ALTER TABLE IF EXISTS public.contract_offer_layer
    ADD CONSTRAINT contract_offer_layer_pkey PRIMARY KEY (offer_id, layer_number);
ALTER TABLE IF EXISTS public.contract_offer
    ADD CONSTRAINT contract_offer_pkey PRIMARY KEY (offer_id);
ALTER TABLE IF EXISTS public.contract
    ADD CONSTRAINT contract_pkey PRIMARY KEY (contract_id);
ALTER TABLE IF EXISTS public.contract_pricing_outputs
    ADD CONSTRAINT contract_pricing_outputs_pkey PRIMARY KEY (output_id);
ALTER TABLE IF EXISTS public.contract_pricing_patterns
    ADD CONSTRAINT contract_pricing_patterns_pkey PRIMARY KEY (pattern_id);
ALTER TABLE IF EXISTS public.contract_pricing_yearly
    ADD CONSTRAINT contract_pricing_yearly_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.contract_prop_details
    ADD CONSTRAINT contract_prop_details_pkey PRIMARY KEY (detail_id);
ALTER TABLE IF EXISTS public.contract_risk_profile_band
    ADD CONSTRAINT contract_risk_profile_band_pkey PRIMARY KEY (band_id);
ALTER TABLE IF EXISTS public.contract_risk_profile
    ADD CONSTRAINT contract_risk_profile_pkey PRIMARY KEY (profile_id);
ALTER TABLE IF EXISTS public.contract_straight_experience
    ADD CONSTRAINT contract_straight_experience_pkey PRIMARY KEY (exp_id);
ALTER TABLE IF EXISTS public.contract_straight_uw_stats
    ADD CONSTRAINT contract_straight_uw_stats_pkey PRIMARY KEY (stat_id);
ALTER TABLE IF EXISTS public.contract_terms_snapshot
    ADD CONSTRAINT contract_terms_snapshot_pkey PRIMARY KEY (snapshot_id);
ALTER TABLE IF EXISTS public.contract_triangle_cells
    ADD CONSTRAINT contract_triangle_cells_pkey PRIMARY KEY (cell_id);
ALTER TABLE IF EXISTS public.contract_underwriting_limit
    ADD CONSTRAINT contract_underwriting_limit_pkey PRIMARY KEY (contract_id, class_of_business_id);
ALTER TABLE IF EXISTS public.contract_workflow_event
    ADD CONSTRAINT contract_workflow_event_pkey PRIMARY KEY (event_id);
ALTER TABLE IF EXISTS public.country
    ADD CONSTRAINT country_pkey PRIMARY KEY (country_id);
ALTER TABLE IF EXISTS public.currency
    ADD CONSTRAINT currency_pkey PRIMARY KEY (currency_id);
ALTER TABLE IF EXISTS public.pd_brokers
    ADD CONSTRAINT pd_brokers_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_cedants
    ADD CONSTRAINT pd_cedants_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_contract_metrics
    ADD CONSTRAINT pd_contract_metrics_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_contract_terms
    ADD CONSTRAINT pd_contract_terms_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_contracts
    ADD CONSTRAINT pd_contracts_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_countries
    ADD CONSTRAINT pd_countries_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_currencies
    ADD CONSTRAINT pd_currencies_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_lobs
    ADD CONSTRAINT pd_lobs_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_model_runs
    ADD CONSTRAINT pd_model_runs_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_regions
    ADD CONSTRAINT pd_regions_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pd_stg_all_contracts
    ADD CONSTRAINT pd_stg_all_contracts_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pricing_component_snapshots
    ADD CONSTRAINT pricing_component_snapshots_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.pricing_components
    ADD CONSTRAINT pricing_components_pkey PRIMARY KEY (pricing_component_id);
ALTER TABLE IF EXISTS public.pricing_leads
    ADD CONSTRAINT pricing_leads_pkey PRIMARY KEY (contract_id);
ALTER TABLE IF EXISTS public.pricing_share_scenarios
    ADD CONSTRAINT pricing_share_scenarios_pkey PRIMARY KEY (contract_id, share_label);
ALTER TABLE IF EXISTS public.quote_cat_loss_report
    ADD CONSTRAINT quote_cat_loss_report_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_cedant_exposure
    ADD CONSTRAINT quote_cedant_exposure_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_claims_profile_band
    ADD CONSTRAINT quote_claims_profile_band_pkey PRIMARY KEY (band_id);
ALTER TABLE IF EXISTS public.quote_claims_profile
    ADD CONSTRAINT quote_claims_profile_pkey PRIMARY KEY (profile_id);
ALTER TABLE IF EXISTS public.quote_class_of_business
    ADD CONSTRAINT quote_class_of_business_pkey PRIMARY KEY (quote_id, class_of_business_id);
ALTER TABLE IF EXISTS public.quote_commission_slides
    ADD CONSTRAINT quote_commission_slides_pkey PRIMARY KEY (quote_id, row_no);
ALTER TABLE IF EXISTS public.quote_commissions
    ADD CONSTRAINT quote_commissions_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_cresta_data
    ADD CONSTRAINT quote_cresta_data_pkey PRIMARY KEY (cresta_id);
ALTER TABLE IF EXISTS public.quote_dev_factor
    ADD CONSTRAINT quote_dev_factor_pkey PRIMARY KEY (quote_id, triangle_type, dev_month);
ALTER TABLE IF EXISTS public.quote_epi_split
    ADD CONSTRAINT quote_epi_split_pkey PRIMARY KEY (quote_id, class_of_business_id);
ALTER TABLE IF EXISTS public.quote_large_loss_report
    ADD CONSTRAINT quote_large_loss_report_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_loss_participation
    ADD CONSTRAINT quote_loss_participation_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_np_details
    ADD CONSTRAINT quote_np_details_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_np_egnpi_year
    ADD CONSTRAINT quote_np_egnpi_year_pkey PRIMARY KEY (egnpi_year_id);
ALTER TABLE IF EXISTS public.quote_np_expiring_layers
    ADD CONSTRAINT quote_np_expiring_layers_pkey PRIMARY KEY (expiring_layer_id);
ALTER TABLE IF EXISTS public.quote_np_expiring_terms
    ADD CONSTRAINT quote_np_expiring_terms_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.quote_np_layers
    ADD CONSTRAINT quote_np_layers_pkey PRIMARY KEY (quote_id, layer_number);
ALTER TABLE IF EXISTS public.quote_np_pricing_inputs
    ADD CONSTRAINT quote_np_pricing_inputs_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_np_pricing_layer_inputs
    ADD CONSTRAINT quote_np_pricing_layer_inputs_pkey PRIMARY KEY (quote_id, layer_number);
ALTER TABLE IF EXISTS public.quote_np_pricing_outputs
    ADD CONSTRAINT quote_np_pricing_outputs_pkey PRIMARY KEY (quote_id, layer_number, section);
ALTER TABLE IF EXISTS public.quote_np_terms
    ADD CONSTRAINT quote_np_terms_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_offer
    ADD CONSTRAINT quote_offer_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote
    ADD CONSTRAINT quote_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_pricing_outputs
    ADD CONSTRAINT quote_pricing_outputs_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_pricing_yearly
    ADD CONSTRAINT quote_pricing_yearly_pkey PRIMARY KEY (id);
ALTER TABLE IF EXISTS public.quote_prop_details
    ADD CONSTRAINT quote_prop_details_pkey PRIMARY KEY (quote_id);
ALTER TABLE IF EXISTS public.quote_risk_profile_band
    ADD CONSTRAINT quote_risk_profile_band_pkey PRIMARY KEY (band_id);
ALTER TABLE IF EXISTS public.quote_risk_profile
    ADD CONSTRAINT quote_risk_profile_pkey PRIMARY KEY (profile_id);
ALTER TABLE IF EXISTS public.quote_triangle_cells
    ADD CONSTRAINT quote_triangle_cells_pkey PRIMARY KEY (cell_id);
ALTER TABLE IF EXISTS public.quote_underwriting_limit
    ADD CONSTRAINT quote_underwriting_limit_pkey PRIMARY KEY (quote_id, class_of_business_id);
ALTER TABLE IF EXISTS public.ref_benchmark_ldf
    ADD CONSTRAINT ref_benchmark_ldf_pkey PRIMARY KEY (benchmark_id);
ALTER TABLE IF EXISTS public.ref_country_inflation
    ADD CONSTRAINT ref_country_inflation_pkey PRIMARY KEY (country_id, uw_year);
ALTER TABLE IF EXISTS public.ref_cresta_zone
    ADD CONSTRAINT ref_cresta_zone_pkey PRIMARY KEY (zone_db_id);
ALTER TABLE IF EXISTS public.ref_exchange_rate
    ADD CONSTRAINT ref_exchange_rate_pkey PRIMARY KEY (rate_id);
ALTER TABLE IF EXISTS public.ref_list_item
    ADD CONSTRAINT ref_list_item_pkey PRIMARY KEY (item_id);
ALTER TABLE IF EXISTS public.ref_list
    ADD CONSTRAINT ref_list_pkey PRIMARY KEY (list_id);
ALTER TABLE IF EXISTS public.ref_swiss_re_curve
    ADD CONSTRAINT ref_swiss_re_curve_pkey PRIMARY KEY (curve_name, x);
ALTER TABLE IF EXISTS public.reinsurers
    ADD CONSTRAINT reinsurers_pkey PRIMARY KEY (reinsurer_id);
ALTER TABLE IF EXISTS public.treaty_type
    ADD CONSTRAINT treaty_type_pkey PRIMARY KEY (treaty_type_id);
ALTER TABLE IF EXISTS public.uw_role_class_restriction
    ADD CONSTRAINT uw_role_class_restriction_pkey PRIMARY KEY (role_id, class_of_business_id);
ALTER TABLE IF EXISTS public.uw_role
    ADD CONSTRAINT uw_role_pkey PRIMARY KEY (role_id);
ALTER TABLE IF EXISTS public.uw_user
    ADD CONSTRAINT uw_user_pkey PRIMARY KEY (user_id);

-- Unique constraints
ALTER TABLE IF EXISTS public.approval_decision
    ADD CONSTRAINT approval_decision_unique UNIQUE (request_id, decided_by);
ALTER TABLE IF EXISTS public.contract_cat_loss_report
    ADD CONSTRAINT contract_cat_loss_report_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_claims_profile
    ADD CONSTRAINT contract_claims_profile_contract_id_class_of_business_id_key UNIQUE (contract_id, class_of_business_id);
ALTER TABLE IF EXISTS public.contract_commissions
    ADD CONSTRAINT contract_commissions_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_group
    ADD CONSTRAINT contract_group_cedant_id_uw_year_program_name_key UNIQUE (cedant_id, uw_year, program_name);
ALTER TABLE IF EXISTS public.contract_large_loss_report
    ADD CONSTRAINT contract_large_loss_report_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_loss_participation
    ADD CONSTRAINT contract_loss_participation_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_np_details
    ADD CONSTRAINT contract_np_details_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_np_egnpi_year
    ADD CONSTRAINT contract_np_egnpi_year_unique UNIQUE (contract_id, uw_year);
ALTER TABLE IF EXISTS public.contract_np_expiring_layers
    ADD CONSTRAINT contract_np_expiring_layers_contract_id_layer_number_key UNIQUE (contract_id, layer_number);
ALTER TABLE IF EXISTS public.contract_np_expiring_terms
    ADD CONSTRAINT contract_np_expiring_terms_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_np_layers
    ADD CONSTRAINT contract_np_layers_contract_layer_key UNIQUE (contract_id, layer_number);
ALTER TABLE IF EXISTS public.contract_np_terms
    ADD CONSTRAINT contract_np_terms_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_offer
    ADD CONSTRAINT contract_offer_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_pricing_outputs
    ADD CONSTRAINT contract_pricing_outputs_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_pricing_patterns
    ADD CONSTRAINT contract_pricing_patterns_contract_id_triangle_type_key UNIQUE (contract_id, triangle_type);
ALTER TABLE IF EXISTS public.contract_pricing_yearly
    ADD CONSTRAINT contract_pricing_yearly_contract_id_uw_year_record_type_key UNIQUE (contract_id, uw_year, record_type);
ALTER TABLE IF EXISTS public.contract_prop_details
    ADD CONSTRAINT contract_prop_details_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_risk_profile
    ADD CONSTRAINT contract_risk_profile_contract_id_class_of_business_id_key UNIQUE (contract_id, class_of_business_id);
ALTER TABLE IF EXISTS public.contract_straight_experience
    ADD CONSTRAINT contract_straight_experience_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.contract_straight_uw_stats
    ADD CONSTRAINT contract_straight_uw_stats_contract_id_underwriting_year_key UNIQUE (contract_id, underwriting_year);
ALTER TABLE IF EXISTS public.contract_triangle_cells
    ADD CONSTRAINT contract_triangle_cells_contract_id_type_origin_year_dev_mo_key UNIQUE (contract_id, type, origin_year, dev_months);
ALTER TABLE IF EXISTS public.currency
    ADD CONSTRAINT currency_code_unique UNIQUE (currency_code);
ALTER TABLE IF EXISTS public.pd_brokers
    ADD CONSTRAINT pd_brokers_name_key UNIQUE (name);
ALTER TABLE IF EXISTS public.pd_cedants
    ADD CONSTRAINT pd_cedants_name_key UNIQUE (name);
ALTER TABLE IF EXISTS public.pd_contract_terms
    ADD CONSTRAINT pd_contract_terms_contract_id_key UNIQUE (contract_id);
ALTER TABLE IF EXISTS public.pd_contracts
    ADD CONSTRAINT pd_contracts_source_key_key UNIQUE (source_key);
ALTER TABLE IF EXISTS public.pd_countries
    ADD CONSTRAINT pd_countries_name_key UNIQUE (name);
ALTER TABLE IF EXISTS public.pd_currencies
    ADD CONSTRAINT pd_currencies_code_key UNIQUE (code);
ALTER TABLE IF EXISTS public.pd_lobs
    ADD CONSTRAINT pd_lobs_name_key UNIQUE (name);
ALTER TABLE IF EXISTS public.pd_regions
    ADD CONSTRAINT pd_regions_name_key UNIQUE (name);
ALTER TABLE IF EXISTS public.pricing_components
    ADD CONSTRAINT pricing_components_contract_id_component_name_key UNIQUE (contract_id, component_name);
ALTER TABLE IF EXISTS public.quote_claims_profile
    ADD CONSTRAINT quote_claims_profile_unique UNIQUE (quote_id, class_of_business_id);
ALTER TABLE IF EXISTS public.quote_np_egnpi_year
    ADD CONSTRAINT quote_np_egnpi_year_unique UNIQUE (quote_id, uw_year);
ALTER TABLE IF EXISTS public.quote_np_expiring_layers
    ADD CONSTRAINT quote_np_expiring_layers_quote_id_layer_number_key UNIQUE (quote_id, layer_number);
ALTER TABLE IF EXISTS public.quote_np_expiring_terms
    ADD CONSTRAINT quote_np_expiring_terms_quote_id_key UNIQUE (quote_id);
ALTER TABLE IF EXISTS public.quote_pricing_yearly
    ADD CONSTRAINT quote_pricing_yearly_unique UNIQUE (quote_id, uw_year, record_type);
ALTER TABLE IF EXISTS public.quote_risk_profile
    ADD CONSTRAINT quote_risk_profile_unique UNIQUE (quote_id, class_of_business_id);
ALTER TABLE IF EXISTS public.quote_triangle_cells
    ADD CONSTRAINT quote_triangle_unique UNIQUE (quote_id, type, origin_year, dev_months);
ALTER TABLE IF EXISTS public.ref_benchmark_ldf
    ADD CONSTRAINT ref_benchmark_ldf_country_id_tail_type_development_month_key UNIQUE (country_id, tail_type, development_month);
ALTER TABLE IF EXISTS public.ref_exchange_rate
    ADD CONSTRAINT ref_exchange_rate_code_date_uq UNIQUE (currency_code, effective_date);
ALTER TABLE IF EXISTS public.ref_list
    ADD CONSTRAINT ref_list_key_unique UNIQUE (list_key);
ALTER TABLE IF EXISTS public.ref_list
    ADD CONSTRAINT ref_list_list_key_key UNIQUE (list_key);
ALTER TABLE IF EXISTS public.reinsurers
    ADD CONSTRAINT reinsurers_reinsurer_name_key UNIQUE (reinsurer_name);
ALTER TABLE IF EXISTS public.treaty_type
    ADD CONSTRAINT treaty_type_unique UNIQUE (treaty_type);
ALTER TABLE IF EXISTS public.pd_contract_metrics
    ADD CONSTRAINT uq_contract_modelrun UNIQUE (contract_id, model_run_id);
ALTER TABLE IF EXISTS public.uw_role
    ADD CONSTRAINT uw_role_role_name_key UNIQUE (role_name);
ALTER TABLE IF EXISTS public.uw_user
    ADD CONSTRAINT uw_user_email_key UNIQUE (email);