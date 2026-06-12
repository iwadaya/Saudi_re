// client/src/types/pricing.ts — canonical data contracts for the money path.
//
// Shapes are derived from the actual server responses (server/src/routes/*,
// server/src/modules/pricing/*) — see docs/frontend-hardening.md Phase 1.
// Keep these in sync with the SQL in server/src/db/migrations/ when columns
// change; the client typecheck is the tripwire for silent payload drift.
//
// ── The NumericLike trap ────────────────────────────────────────────────────
// Postgres NUMERIC/DECIMAL columns arrive over JSON as *strings* (node-pg
// returns them as strings and the server registers no custom type parser).
// Server-computed values are plain numbers, and absent values are null, so a
// money field can legitimately be any of "1250000.00" | 1250000 | null.
// NEVER do arithmetic or comparisons on a NumericLike without coercing
// (Number(...) / the screens' cn() helper) — `"9" > 10` is a silent money bug.

export type NumericLike = number | string | null;

/** ISO-8601 date or timestamp string as serialized by JSON.stringify(Date). */
export type IsoDateString = string;

/** UUID primary keys (plain string at runtime; alias documents intent). */
export type Uuid = string;

/** Honest type for parsed JSON whose schema is intentionally free-form (JSONB columns). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Standard mutation acknowledgement; updated_at feeds optimistic locking. */
export interface SaveResult {
  ok: boolean;
  updated_at?: IsoDateString | null;
}

// ── Error bodies (server/src/middleware/errorHandler.js) ───────────────────

export interface ApiErrorBody {
  error: string;
  code?: string;
  requestId?: string | null;
}

/** 412/409 optimistic-lock conflict (code STALE_WRITE). */
export interface StaleWriteErrorBody extends ApiErrorBody {
  code: 'STALE_WRITE';
  current?: IsoDateString;
  expected?: IsoDateString;
}

export interface PricingDriftItem {
  layer_number: number;
  section: string;
  fieldName: string;
  clientValue: number | null;
  expectedValue: number | null;
  reason: string;
}

/** 422 server-side pricing spot-check failure (code PRICING_DRIFT). */
export interface PricingDriftErrorBody extends ApiErrorBody {
  code: 'PRICING_DRIFT';
  drifts: PricingDriftItem[];
}

// ── Reference data ──────────────────────────────────────────────────────────

/** Generic lookup row (brokers, reinsurers, treaty types, COBs, ref lists). */
export interface RefItem {
  id: Uuid;
  name: string;
  code?: string | null;
  [extra: string]: unknown;
}

// ── Treaty / contract bundle (GET /api/treaties/:id) ───────────────────────

export type ContractStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'AWAITING_SIGNED_LINE'
  | 'SIGNED'
  | 'NTU'
  | 'DECLINED'
  | (string & {}); // server enums grow; keep assignable while preserving autocomplete

export interface ContractHeader {
  cedant_id: Uuid | null;
  broker_id: Uuid | null;
  currency_id: Uuid | null;
  country_id: Uuid | null;
  treaty_type_id: Uuid | null;
  uw_year: number | null;
  status: ContractStatus | null;
  uw_status?: string | null;
  experience_source?: string | null;
  cedant_name?: string | null;
  broker_name?: string | null;
  country_name?: string | null;
  country_code?: string | null;
  treaty_type_name?: string | null;
  treaty_category?: string | null;
  currency_code?: string | null;
  renewal_date?: IsoDateString | null;
  signed_line_pct?: NumericLike;
  primary_class_of_business_id?: Uuid | null;
  contract_group_id?: Uuid | null;
  parent_contract_id?: Uuid | null;
  inception_date?: IsoDateString | null;
  contract_description?: string | null;
  alt_contract_id?: string | null;
  [extra: string]: unknown;
}

/**
 * Proportional treaty terms (contract_detail row). The prompt-pack's
 * "TreatyDetail": limits, retentions, EPIs and cost ratios for QS/Surplus.
 */
export interface TreatyDetail {
  triangulations_available?: boolean | null;
  inception_date?: IsoDateString | null;
  renewal_date?: IsoDateString | null;
  experience_start_year?: number | null;
  qs_limit?: NumericLike;
  retention_pct?: NumericLike;
  retention_amt?: NumericLike;
  cession_pct?: NumericLike;
  cession_amt?: NumericLike;
  surplus_max_retention?: NumericLike;
  num_lines?: NumericLike;
  total_capacity?: NumericLike;
  event_limit?: NumericLike;
  aal?: NumericLike;
  quota_share_epi?: NumericLike;
  surplus_epi?: NumericLike;
  brokerage_pct?: NumericLike;
  taxes_pct?: NumericLike;
  loss_cap_pct?: NumericLike;
  strip_large_cat_losses?: boolean | null;
  [extra: string]: unknown;
}

export interface SlidingTableRow {
  row_no: number;
  loss_ratio_pct: NumericLike;
  commission_pct: NumericLike;
}

export interface ContractCommissions {
  mode?: 'FIXED' | 'SLIDING' | (string & {}) | null;
  fixed_commission_pct?: NumericLike;
  fixed_commission_qs_pct?: NumericLike;
  fixed_commission_surplus_pct?: NumericLike;
  provisional_commission_pct?: NumericLike;
  sliding_min_loss_ratio?: NumericLike;
  sliding_max_loss_ratio?: NumericLike;
  sliding_min_commission?: NumericLike;
  sliding_max_commission?: NumericLike;
  mgmt_expenses_pct?: NumericLike;
  profit_commission_pct?: NumericLike;
  lcf_years?: NumericLike;
  lcf_extinction?: boolean | null;
  sliding_table?: SlidingTableRow[];
  [extra: string]: unknown;
}

export interface LossParticipation {
  enabled?: boolean | null;
  min_loss_ratio_pct?: NumericLike;
  max_loss_ratio_pct?: NumericLike;
  reinsurer_share_pct?: NumericLike;
  slides?: unknown[];
}

export interface EpiSplitRow {
  class_of_business_id?: Uuid | null;
  class_id?: Uuid | null;
  premium?: NumericLike;
  [extra: string]: unknown;
}

export interface UnderwritingLimitRow {
  class_of_business_id?: Uuid | null;
  limit_amount?: NumericLike;
  basis?: string | null;
  [extra: string]: unknown;
}

/** Full GET /api/treaties/:id (or /api/quotes/:id) bundle. */
export interface ContractBundle {
  contract_id?: Uuid;
  quote_id?: Uuid;
  updated_at: IsoDateString | null;
  created_at?: IsoDateString | null;
  class_ids?: Uuid[];
  header: ContractHeader | null;
  detail: TreatyDetail | null;
  commissions: ContractCommissions | null;
  lossParticipation?: LossParticipation | null;
  epi_split?: EpiSplitRow[];
  underwriting_limits?: UnderwritingLimitRow[];
  [extra: string]: unknown;
}

// ── Non-proportional structure (GET /:id/non-prop) ─────────────────────────

export type PerilScope = 'RISK' | 'CAT' | 'BOTH';

export interface NpDetail {
  contract_id?: Uuid;
  number_of_layers?: NumericLike;
  expiring_number_of_layers?: NumericLike;
  deductible?: NumericLike;
  max_retention?: NumericLike;
  accounting_method?: string | null;
  xl_type?: string | null;
  accounts?: string | null;
  brokerage_pct?: NumericLike;
  taxes_pct?: NumericLike;
  no_claims_bonus_pct?: NumericLike;
  profit_commission_pct?: NumericLike;
  est_gnpi?: NumericLike;
  adjustment_rate?: NumericLike;
  deposit_premium?: NumericLike;
  experience_start_year?: number | null;
  [extra: string]: unknown;
}

/** One XL layer of the treaty structure (contract_np_layer row). */
export interface NpLayer {
  layer_id?: Uuid;
  contract_id?: Uuid;
  layer_number: number;
  attachment: NumericLike;
  layer_limit: NumericLike;
  aggregate_limit?: NumericLike;
  egnpi?: NumericLike;
  earned_premium?: NumericLike;
  rate?: NumericLike;
  rol?: NumericLike;
  /** UNLIMITED is stored as null. */
  num_reinstatements?: NumericLike;
  reinstatement_pct?: NumericLike;
  annual_agg_deductible?: NumericLike;
  peril_scope?: PerilScope | null;
  mdp?: NumericLike;
  mdp_pct?: NumericLike;
  hist_margin?: NumericLike;
  modelled_margin?: NumericLike;
  tech_ratio?: NumericLike;
  uw_price?: NumericLike;
  expiring_price?: NumericLike;
  lead_price?: NumericLike;
  class_of_business_ids?: Uuid[];
  [extra: string]: unknown;
}

/**
 * GET /:id/non-prop — the structure a quote/treaty is priced on.
 * (The prompt-pack's "QuoteStructure"; identical for quote and treaty mode.)
 */
export interface QuoteStructure {
  detail: NpDetail | null;
  layers: NpLayer[];
  /** Free-form JSONB terms blob (contract_np_terms.terms). */
  terms?: Record<string, JsonValue> | null;
  cob_underwriting_limits?: Array<{ cob_id: Uuid; limit_amount: NumericLike }>;
  uw_status?: string | null;
  offer_status?: string | null;
  offer_approver?: string | null;
  updated_at: IsoDateString | null;
  [extra: string]: unknown;
}

// ── Non-proportional pricing (GET/PUT /:id/np-pricing) ─────────────────────

export interface NpPricingInputs {
  contract_id?: Uuid;
  burn_weight_pct?: NumericLike;
  exposure_weight_pct?: NumericLike;
  pareto_weight_pct?: NumericLike;
  pricing_loading_pct?: NumericLike;
  swiss_re_curve_name?: string | null;
  [extra: string]: unknown;
}

export interface NpLayerInputRow {
  contract_id?: Uuid;
  layer_number: number;
  expiring_pricing_pct?: NumericLike;
  [extra: string]: unknown;
}

/**
 * Per-layer / per-section pricing output row (contract_np_pricing_output).
 * The prompt-pack's "LayerPricing" — the heart of the NP money path.
 */
export interface LayerPricing {
  contract_id?: Uuid;
  layer_number: number;
  /** Pricing section, e.g. 'RISK' | 'CAT'. */
  section: string;
  pure_burning_cost?: NumericLike;
  pareto_pricing?: NumericLike;
  burn_plus_pareto?: NumericLike;
  exposure_rating?: NumericLike;
  burn_weight_pct?: NumericLike;
  exposure_weight_pct?: NumericLike;
  pareto_weight_pct?: NumericLike;
  pricing_loading_pct?: NumericLike;
  total_price?: NumericLike;
  prob_attach?: NumericLike;
  prob_exhaust?: NumericLike;
  [extra: string]: unknown;
}

export interface NpPricingBundle {
  inputs: NpPricingInputs | null;
  layer_inputs: NpLayerInputRow[];
  outputs: LayerPricing[];
}

// ── NP supporting screens ───────────────────────────────────────────────────

export interface NpExpiringLayer {
  layer_number: number;
  attachment?: NumericLike;
  layer_limit?: NumericLike;
  aggregate_limit?: NumericLike;
  egnpi?: NumericLike;
  earned_premium?: NumericLike;
  rate?: NumericLike;
  rol?: NumericLike;
  num_reinstatements?: NumericLike;
  reinstatement_pct?: NumericLike;
  annual_agg_deductible?: NumericLike;
  peril_scope?: PerilScope | null;
  mdp?: NumericLike;
  mdp_pct?: NumericLike;
  /** Set when auto-populated from the parent contract on renewal. */
  _auto?: boolean;
  [extra: string]: unknown;
}

export interface NpExpiringTerms {
  egnpi?: NumericLike;
  deductible?: NumericLike;
  risk_limit?: NumericLike;
  cat_limit?: NumericLike;
  brokerage_pct?: NumericLike;
  no_claims_bonus_pct?: NumericLike;
  profit_commission_pct?: NumericLike;
  notes?: string | null;
  _auto?: boolean;
  [extra: string]: unknown;
}

export interface NpExpiringBundle {
  layers: NpExpiringLayer[];
  terms: NpExpiringTerms | null;
  coveredProps?: unknown[];
  autoPopulated?: boolean;
  isRenewal?: boolean;
  parentContractId?: Uuid | null;
  updated_at: IsoDateString | null;
}

export interface NpHistoricalRow {
  contract_id?: Uuid;
  quote_id?: Uuid;
  uw_year: number;
  premiums?: NumericLike;
  claims?: NumericLike;
  egnpi?: NumericLike;
  result?: NumericLike;
  loss_ratio?: NumericLike;
  expense_ratio?: NumericLike;
  combined_ratio?: NumericLike;
  [extra: string]: unknown;
}

export interface EgnpiYearRow {
  contract_id?: Uuid;
  uw_year: number;
  egnpi?: NumericLike;
  inflation_pct?: NumericLike;
  rate_change_pct?: NumericLike;
  [extra: string]: unknown;
}

/** Stop-loss pricing persists free-form JSONB inputs/outputs. */
export interface StopLossPricingBundle {
  inputs: Record<string, JsonValue>;
  outputs: Record<string, JsonValue> | null;
  updated_at?: IsoDateString | null;
}

// ── Proportional pricing (GET /:id/pricing, POST /api/pricing/save) ────────

export interface PricingOutputs {
  contract_id?: Uuid;
  epi?: NumericLike;
  attritional_ratio?: NumericLike;
  large_loss_load?: NumericLike;
  cat_loss_load?: NumericLike;
  commission_ratio?: NumericLike;
  brokerage_ratio?: NumericLike;
  tax_ratio?: NumericLike;
  technical_result?: NumericLike;
  max_commission?: NumericLike;
  target_margin?: NumericLike;
  uw_comment?: string | null;
  offer_status?: string | null;
  offer_line?: string | null;
  offer_comment?: string | null;
  offer_approver?: string | null;
  signed_line_pct?: NumericLike;
  actuarial_margin?: NumericLike;
  actual_margin?: NumericLike;
  uw_margin?: NumericLike;
  [extra: string]: unknown;
}

export interface PricingYearlyRow {
  contract_id?: Uuid;
  uw_year: number;
  ultimate_premium?: NumericLike;
  ultimate_loss?: NumericLike;
  loss_ratio?: NumericLike;
  commission_amt?: NumericLike;
  brokerage_amt?: NumericLike;
  technical_result?: NumericLike;
  record_type?: string | null;
  [extra: string]: unknown;
}

export interface PricingComponentRow {
  contract_id?: Uuid;
  component_name: string;
  selected?: boolean | null;
  actuarial_value?: NumericLike;
  uw_value?: NumericLike;
  underwriter_value?: NumericLike;
  market_value?: NumericLike;
  actual_stats_value?: NumericLike;
  exposure_value?: NumericLike;
  comment?: string | null;
  display_order?: number | null;
  [extra: string]: unknown;
}

export interface PricingLeads {
  contract_id?: Uuid;
  lead_reinsurer?: string | null;
  expiring_reinsurer?: string | null;
  lead_share_pct?: NumericLike;
  [extra: string]: unknown;
}

export interface PricingBundle {
  outputs: PricingOutputs | null;
  yearly: PricingYearlyRow[];
  components: PricingComponentRow[];
  leads?: PricingLeads | null;
  share_scenarios?: Array<Record<string, unknown>>;
  [extra: string]: unknown;
}

// ── Development factors (GET/PUT /:id/dev-factors/:type) ───────────────────

export type TriangleType = 'CLAIMS_PAID' | 'CLAIMS_OS' | 'INCURRED' | (string & {});

export interface DevFactorRow {
  contract_id?: Uuid;
  triangle_type?: TriangleType;
  dev_month: number;
  selected_ldf?: NumericLike;
  selected_cdf?: NumericLike;
  actual_ldf?: NumericLike;
  actual_cdf?: NumericLike;
  param_ldf?: NumericLike;
  param_cdf?: NumericLike;
  parametrized_ldf?: NumericLike;
  parametrized_cdf?: NumericLike;
  chosen_source?: string | null;
  chosen_ldf?: NumericLike;
  chosen_cdf?: NumericLike;
  overridden?: boolean | null;
  saved_at?: IsoDateString;
  [extra: string]: unknown;
}

/** The full factor set for one triangle type, ordered by dev_month. */
export type DevFactorSet = DevFactorRow[];

// ── Triangles ───────────────────────────────────────────────────────────────

export interface TriangleCell {
  cell_id?: Uuid;
  origin_year: number;
  dev_months: number;
  cum_value: NumericLike;
  [extra: string]: unknown;
}

export interface TriangleResponse {
  cells: TriangleCell[];
  [extra: string]: unknown;
}

export interface TriangleWithExclusions {
  full: TriangleResponse;
  stripped: TriangleResponse;
  exclusions: {
    largeLossCount: number;
    catLossCount: number;
    applies: boolean;
    proxyPlaced?: number;
    reportedPlaced?: number;
    [extra: string]: unknown;
  };
}

// ── Loss records (large / cat losses) ───────────────────────────────────────

/** One loss row as stored in a large/cat loss report. */
export interface LossRecord {
  loss_id?: Uuid;
  report_id?: Uuid;
  uw_year: number | null;
  insured_name?: string | null;
  loss_name?: string | null;
  date_of_loss?: IsoDateString | null;
  class_of_business?: string | null;
  paid: NumericLike;
  os: NumericLike;
  incurred: NumericLike;
  is_selected?: boolean | null;
  inflation_factor?: NumericLike;
  /** "Universe saved" date — preserved across saves. */
  reported_date?: IsoDateString | null;
  /** User-entered date driving triangle placement/stripping. */
  actuarial_reported_date?: IsoDateString | null;
  policy_inception_date?: IsoDateString | null;
  [extra: string]: unknown;
}

/**
 * Loosest loss-row contract the NP pricing engine accepts: screens feed it
 * rows from saved reports, snapshots, or unsaved grid edits, so every field
 * is optional and money fields are unknown until coerced with cn()/toN().
 */
export interface LossLike {
  uw_year?: number | string | null;
  paid?: unknown;
  os?: unknown;
  incurred?: unknown;
  inflated_incurred?: unknown;
  inflation_factor?: unknown;
  is_selected?: boolean | null;
  class_of_business?: string | null;
  classOfBusiness?: string | null;
  [extra: string]: unknown;
}

export interface LossReport {
  report_id: Uuid;
  contract_id?: Uuid;
  report_date?: IsoDateString | null;
  created_at?: IsoDateString;
  updated_at?: IsoDateString;
  [extra: string]: unknown;
}

export interface LossReportBundle {
  report: LossReport | null;
  losses: LossRecord[];
}

export interface LossSaveResult {
  ok: boolean;
  report_id?: Uuid;
  loss_ids?: Uuid[];
}

// ── Loss selection snapshots (Pareto fits etc.) ─────────────────────────────

export type LossType = 'large' | 'cat' | 'LARGE' | 'CAT' | (string & {});

export interface LossSelectionSnapshot {
  snapshot_id?: Uuid;
  contract_id?: Uuid;
  loss_type?: LossType;
  inflation_mode?: string | null;
  inflation_index?: string | null;
  inflation_rate_pct?: NumericLike;
  inflation_base_year?: number | null;
  inflation_to_year?: number | null;
  threshold?: NumericLike;
  global_factor?: NumericLike;
  selected_count?: NumericLike;
  loadings?: JsonValue | null;
  total_loading_pct?: NumericLike;
  distribution_fits?: JsonValue | null;
  active_distribution?: string | null;
  pareto_xm?: NumericLike;
  pareto_alpha?: NumericLike;
  pareto_limit?: NumericLike;
  observation_years?: NumericLike;
  return_period_curve?: JsonValue | null;
  return_period_key_points?: JsonValue | null;
  assumptions_hash?: string | null;
  created_at?: IsoDateString;
  [extra: string]: unknown;
}

export interface LossSelectionItem {
  snapshot_id?: Uuid;
  uw_year?: number | null;
  insured_name?: string | null;
  loss_name?: string | null;
  date_of_loss?: IsoDateString | null;
  class_of_business?: string | null;
  paid: NumericLike;
  os: NumericLike;
  incurred: NumericLike;
  inflation_factor?: NumericLike;
  inflated_incurred?: NumericLike;
  source_loss_id?: Uuid | null;
  [extra: string]: unknown;
}

export interface LossSelectionBundle {
  snapshot: LossSelectionSnapshot | null;
  items?: LossSelectionItem[];
}

export interface LossSelectionSaveResult {
  ok: boolean;
  snapshot: LossSelectionSnapshot;
}

// ── Risk / claims profiles ──────────────────────────────────────────────────

/**
 * One profile band (risk- or claims-profile row). The prompt-pack's
 * "ProfilePoint": a band of the sum-insured / claims distribution.
 */
export interface ProfilePoint {
  profile_id?: Uuid;
  from_amt: NumericLike;
  to_amt: NumericLike;
  no_of_risks?: NumericLike;
  total_sum_insured?: NumericLike;
  gross_premium?: NumericLike;
  [extra: string]: unknown;
}

export interface RiskProfileHeader {
  profile_id?: Uuid;
  contract_id?: Uuid;
  class_of_business_id?: Uuid;
  c_value?: NumericLike;
  pml_percentage?: NumericLike;
  selected_curve?: string | null;
  custom_b?: NumericLike;
  custom_g?: NumericLike;
  gross_loss_ratio?: NumericLike;
  [extra: string]: unknown;
}

export interface ProfileBundle {
  profile: RiskProfileHeader | null;
  bands: ProfilePoint[];
}

// ── Misc money-path lookups ─────────────────────────────────────────────────

/** Class-of-business link row (GET /:id/cobs). */
export interface CobLinkRow {
  class_of_business_id: Uuid;
  name?: string | null;
  code?: string | null;
  [extra: string]: unknown;
}

/** One point of a Swiss Re exposure curve (GET /api/ref/swiss-re-curves/:name). */
export interface CurvePoint {
  x: NumericLike;
  y: NumericLike;
}

/** GET /api/pricing/market-average/:countryId */
export interface MarketAverageResult {
  components: Record<string, number | null>;
  tier?: string | null;
  contractCount?: number;
  [extra: string]: unknown;
}

// ── Facultative ─────────────────────────────────────────────────────────────

export interface FacRisk {
  fac_risk_id: Uuid;
  cedant_id?: Uuid | null;
  broker_id?: Uuid | null;
  country_id?: Uuid | null;
  currency_id?: Uuid | null;
  insured_name: string;
  insured_address?: string | null;
  nature_of_business?: string | null;
  fac_cob_id?: Uuid | null;
  inception_date?: IsoDateString | null;
  expiry_date?: IsoDateString | null;
  policy_period_months?: NumericLike;
  uw_year?: number | null;
  total_sum_insured?: NumericLike;
  pd_sum_insured?: NumericLike;
  bi_sum_insured?: NumericLike;
  placement_type?: 'PROPORTIONAL' | 'NON_PROPORTIONAL' | (string & {}) | null;
  cedant_retention_pct?: NumericLike;
  ri_share_pct?: NumericLike;
  our_share_pct?: NumericLike;
  np_retention?: NumericLike;
  np_limit?: NumericLike;
  np_our_share_pct?: NumericLike;
  deductible_amount?: NumericLike;
  deductible_description?: string | null;
  commission_pct?: NumericLike;
  brokerage_pct?: NumericLike;
  taxes_pct?: NumericLike;
  original_premium?: NumericLike;
  ri_premium?: NumericLike;
  original_rate?: NumericLike;
  pml_amount?: NumericLike;
  pml_pct?: NumericLike;
  mfl_amount?: NumericLike;
  mfl_pct?: NumericLike;
  linked_contract_id?: Uuid | null;
  underwriter_notes?: string | null;
  status?: string | null;
  occupancy_code?: number | null;
  occupancy_name?: string | null;
  hazard_grade_override?: number | null;
  hazard_category?: string | null;
  risk_category?: number | null;
  frequency_category?: number | null;
  cedant_name?: string | null;
  country_name?: string | null;
  cob_name?: string | null;
  cob_category?: string | null;
  currency_code?: string | null;
  broker_name?: string | null;
  created_at?: IsoDateString;
  updated_at?: IsoDateString;
  [extra: string]: unknown;
}

export interface FacPricing {
  fac_risk_id?: Uuid;
  market_rate_per_mille?: NumericLike;
  market_premium?: NumericLike;
  market_source?: string | null;
  actuarial_method?: string | null;
  actuarial_rate_per_mille?: NumericLike;
  actuarial_premium?: NumericLike;
  expected_loss_ratio?: NumericLike;
  loss_cost?: NumericLike;
  loading_pct?: NumericLike;
  market_weight_pct?: NumericLike;
  actuarial_weight_pct?: NumericLike;
  blended_rate_per_mille?: NumericLike;
  blended_premium?: NumericLike;
  final_rate_per_mille?: NumericLike;
  final_premium?: NumericLike;
  uw_adjustment_pct?: NumericLike;
  uw_adjustment_reason?: string | null;
  burning_cost_ratio?: NumericLike;
  avg_loss_years?: NumericLike;
  /** UI-only free-form state (JSONB). */
  ui_state?: Record<string, JsonValue> | null;
  indemnity_months?: NumericLike;
  commission_pct?: NumericLike;
  margin_pct?: NumericLike;
  other_expenses_pct?: NumericLike;
  extra_cover_loadings?: JsonValue | null;
  market_rate_pm?: NumericLike;
  technical_rate_pm?: NumericLike;
  total_rate_pm?: NumericLike;
  bi_rate_pm?: NumericLike;
  net_rate_pm?: NumericLike;
  final_net_rate_pm?: NumericLike;
  final_gross_rate_pm?: NumericLike;
  technical_premium?: NumericLike;
  expected_premium?: NumericLike;
  underwriting_score?: NumericLike;
  capacity_grade?: string | null;
  uw_action?: string | null;
  max_capacity_pct?: NumericLike;
  max_capacity_sar?: NumericLike;
  market_vs_tech_pct?: NumericLike;
  market_vs_tech_band?: string | null;
  engine_version?: string | null;
  engine_warnings?: JsonValue | null;
  capacity_proposed_pct?: NumericLike;
  accepted_rate_pm?: NumericLike;
  uw_note?: string | null;
  created_at?: IsoDateString;
  updated_at?: IsoDateString;
  [extra: string]: unknown;
}
