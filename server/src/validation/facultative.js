// server/src/validation/facultative.js
// Zod schemas for the facultative risk save endpoints. Follows the
// same primitive composition pattern as quote.js / treaty.js — shared
// helpers live in common.js.

import { z } from 'zod';
import {
  optionalUuid, money, pct100, uwYear, isoDate, boolish,
} from './common.js';

/** Integer in 1..10 used for hazard_grade overrides. */
const hazardGrade1To10 = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}, z.number().int().min(1).max(10).optional());

/** Nullable text — '' / null / undefined all collapse to undefined. */
const optionalText = z.preprocess(
  (v) => (v == null || v === '' ? undefined : String(v)),
  z.string().optional(),
);

/** Optional non-negative integer (e.g. risk_category, frequency_category). */
const optionalInt = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}, z.number().int().optional());

/**
 * Optional decimal in 0..1 (stored that way per migration 080's
 * "-- 0..1" comment). The UI takes percentages (e.g. 80) and divides
 * by 100 before sending — so values arrive here already as fractions.
 * A small overshoot (1.0001) is tolerated to absorb floating-point noise.
 */
const optionalFraction01 = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}, z.number().min(0).max(1.0001).optional());

/** Optional non-negative float — e.g. fx_to_sar. */
const optionalNumber = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().nonnegative().optional());

/** Optional ISO-style 3-letter currency code, case-insensitive. */
const optionalCcy = z.preprocess(
  (v) => (v == null || v === '' ? undefined : String(v).trim().toUpperCase()),
  z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO currency code').optional(),
);

/**
 * PUT /api/fac/risks/:id and POST /api/fac/risks body schema.
 *
 * `.passthrough()` keeps unknown keys so we don't break existing handlers
 * that still read off req.body directly — the schema enforces types on
 * every field it does know about, and unknown keys are logged in dev.
 *
 * All fields are optional: a draft risk can be saved with partial data
 * and progressively filled in via the wizard.
 */
export const facRiskSaveSchema = z.object({
  // Parties
  cedant_id:        optionalUuid,
  broker_id:        optionalUuid,
  country_id:       optionalUuid,
  currency_id:      optionalUuid,

  // Insured + class of business
  insured_name:        optionalText,
  insured_address:     optionalText,
  nature_of_business:  optionalText,
  fac_cob_id:          optionalUuid,

  // Policy period
  inception_date:        isoDate,
  expiry_date:           isoDate,
  policy_period_months:  z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }, z.number().int().min(1).max(120).optional()),
  uw_year:               uwYear,

  // Sums insured
  total_sum_insured:  money,
  pd_sum_insured:     money,
  bi_sum_insured:     money,

  // Placement / commercial terms
  placement_type:       optionalText,
  cedant_retention_pct: pct100,
  ri_share_pct:         pct100,
  our_share_pct:        pct100,
  np_retention:         money,
  np_limit:             money,
  np_our_share_pct:     pct100,
  deductible_amount:    money,
  deductible_description: optionalText,
  commission_pct:       pct100,
  brokerage_pct:        pct100,
  taxes_pct:            pct100,
  original_premium:     money,
  ri_premium:           money,
  original_rate:        z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }, z.number().nonnegative().optional()),

  // PML / MFL
  pml_amount:  money,
  pml_pct:     pct100,
  mfl_amount:  money,
  mfl_pct:     pct100,

  // Status + assignments
  status:                 optionalText,
  assigned_to_user_id:    optionalUuid,
  linked_contract_id:     optionalUuid,
  underwriter_notes:      optionalText,

  // ── Summary Sheet top-half additions (migration 079) ──
  cedant_region:             optionalText,
  renewal_or_new:            optionalText,
  expiring_reference:        optionalText,
  risk_country_zone:         optionalText,
  multi_location_flag:       boolish,
  multi_occupancy_flag:      boolish,
  risk_location_top_address: optionalText,
  occupancy_code:            optionalInt,
  occupancy_name:            optionalText,
  hazard_grade_override:     hazardGrade1To10,
  hazard_category:           optionalText,
  risk_category:             optionalInt,
  frequency_category:        optionalInt,
}).passthrough();


/**
 * One row in the locations save payload. SAR fields (pd_si, bi_si) are
 * still accepted — the UI recomputes them from original × fx on save,
 * but the engine keeps SAR as the canonical aggregation unit.
 */
export const facLocationSchema = z.object({
  location_id:   optionalUuid,
  location_name: optionalText,
  address:       optionalText,
  cresta_zone:   optionalText,
  country_id:    optionalUuid,
  latitude:      optionalNumber,
  longitude:     optionalNumber,

  // Canonical (SAR) — historic columns.
  pd_si:         money,
  bi_si:         money,

  // Migration 080 additions
  occupancy_code:       optionalInt,
  pd_pml_pct:           optionalFraction01,
  bi_pml_pct:           optionalFraction01,
  original_ccy:         optionalCcy,
  original_pd_si:       money,
  original_bi_si:       money,
  fx_to_sar:            optionalNumber,
  carrier_pd_share_pct: optionalFraction01,
  carrier_bi_share_pct: optionalFraction01,
}).passthrough();

export const facLocationsSaveSchema = z.object({
  locations: z.array(facLocationSchema).max(50, 'maximum 50 locations per risk'),
});


/**
 * One row in the sections save payload (migration 133).
 *
 * A section is a class of business on the risk with its own sum insured.
 * The Risk Detail screen has always collected these; until migration 133
 * there was nowhere to put them, so only the first class and the summed
 * total survived a save (finding F6).
 *
 * Only fac_cob_id and section_no are structural. Everything else is the
 * exposure in whatever units the section's rating family uses, and stays
 * optional so a draft saves mid-entry.
 */
export const facSectionSchema = z.object({
  section_no:  z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }, z.number().int().min(1).max(20)),
  fac_cob_id:  z.string().uuid('fac_cob_id must be a UUID'),

  sum_insured:   money,
  exposure_base: money,
  exposure_unit: optionalText,
  limit_amount:  money,
  attachment:    money,
  deductible:    money,
  deductible_basis: optionalText,
  currency_id:   optionalUuid,
  exposure_detail: z.record(z.unknown()).optional(),
}).passthrough();

/**
 * PUT /api/fac/risks/:id/sections — full replacement, like locations.
 * Five sections × the class catalogue is the practical ceiling the UI
 * offers; 100 leaves room without letting a bad payload write unbounded.
 */
export const facSectionsSaveSchema = z.object({
  sections: z.array(facSectionSchema).max(100, 'maximum 100 sections per risk').default([]),
}).passthrough();


/**
 * One layer of an excess tower (migration 136).
 *
 * A facultative excess placement is a tower of layers, each with its own
 * attachment, limit, share, reinstatements and price. Before migration 136
 * `fac_risk` carried a single `np_retention`/`np_limit` pair, so a two-layer
 * placement could only be recorded as one of its layers.
 *
 * `limit_amount` NULL means an unlimited top layer; `reinstatements` NULL
 * means unlimited free reinstatements. Those are different from zero and
 * the difference is the price, so neither is defaulted.
 */
export const facLayerSchema = z.object({
  layer_no: z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }, z.number().int().min(1).max(50)),
  section_id:      optionalUuid,
  attachment:      money,
  limit_amount:    money,
  our_share_pct:   optionalNumber,
  reinstatements:  optionalInt,
  reinstatement_terms: z.array(z.record(z.unknown())).max(50).optional(),
  aggregate_limit: money,
  loss_cost:       money,
  rol_pct:         optionalNumber,
  premium:         money,
  notes:           optionalText,
}).passthrough();

/** PUT /api/fac/risks/:id/layers — full replacement, like sections. */
export const facLayersSaveSchema = z.object({
  layers: z.array(facLayerSchema).max(50, 'maximum 50 layers per risk').default([]),
}).passthrough();

/**
 * One year of exposure history (migration 135).
 *
 * This is the denominator a burning cost divides by. A year with no losses
 * still needs a row — dropping the clean years is the commonest way a burn
 * rate comes out too high.
 */
export const facExperienceBasisRowSchema = z.object({
  loss_year:       z.preprocess((v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }, z.number().int().min(1900).max(2200)),
  exposure_base:   money,
  exposure_unit:   optionalText,
  premium:         money,
  rate_change_pct: optionalNumber,
  claim_count:     optionalInt,
  notes:           optionalText,
}).passthrough();

/** PUT /api/fac/risks/:id/experience — the basis rows plus the risk-level assumptions. */
export const facExperienceSaveSchema = z.object({
  basis:              z.array(facExperienceBasisRowSchema).max(40, 'maximum 40 experience years').default([]),
  severity_trend_pct: optionalNumber,
  experience_years:   optionalInt,
  experience_notes:   optionalText,
}).passthrough();

/**
 * PUT /api/fac/risks/:id/pricing — accepts:
 *   • The historic dual-engine fields (market / actuarial / blend / final).
 *   • The new engine inputs + outputs from computeFacQuote (migration 082).
 *
 * `.passthrough()` keeps unknown keys so the dual-engine ui_state blob
 * and other historical fields stay backward-compatible while the new
 * engine columns are validated.
 */
export const facPricingSaveSchema = z.object({
  // ── Historic dual-engine fields (kept as a safety net while the new
  //    engine becomes the primary writer) ────────────────────────────
  market_rate_per_mille:    optionalNumber,
  market_premium:           money,
  market_source:            optionalText,
  actuarial_method:         optionalText,
  actuarial_rate_per_mille: optionalNumber,
  actuarial_premium:        money,
  expected_loss_ratio:      optionalNumber,
  loss_cost:                money,
  loading_pct:              optionalNumber,
  market_weight_pct:        pct100,
  actuarial_weight_pct:     pct100,
  blended_rate_per_mille:   optionalNumber,
  blended_premium:          money,
  final_rate_per_mille:     optionalNumber,
  final_premium:            money,
  uw_adjustment_pct:        optionalNumber,
  uw_adjustment_reason:     optionalText,
  burning_cost_ratio:       optionalNumber,
  avg_loss_years:           optionalInt,

  // ── Engine inputs (migration 082) ──────────────────────────────────
  indemnity_months:         optionalInt,
  commission_pct:           optionalFraction01,
  margin_pct:               optionalFraction01,
  other_expenses_pct:       optionalFraction01,
  // Free-shape array of { label, pct } pairs; the engine just sums pcts.
  extra_cover_loadings:     z.array(z.unknown()).optional(),
  market_rate_pm:           optionalNumber,

  // ── Engine outputs — rate path ─────────────────────────────────────
  technical_rate_pm:        optionalNumber,
  total_rate_pm:            optionalNumber,
  bi_rate_pm:               optionalNumber,
  net_rate_pm:              optionalNumber,
  final_net_rate_pm:        optionalNumber,
  final_gross_rate_pm:      optionalNumber,
  technical_premium:        money,
  expected_premium:         money,

  // ── Engine outputs — score + decision ──────────────────────────────
  underwriting_score:       optionalNumber,
  capacity_grade:           optionalText,
  uw_action:                optionalText,
  max_capacity_pct:         optionalFraction01,
  max_capacity_sar:         money,
  market_vs_tech_pct:       optionalNumber,
  market_vs_tech_band:      optionalText,

  // Provenance
  engine_version:           optionalText,
  engine_warnings:          z.array(z.unknown()).optional(),
  // Migration 134 — which reference set and which family produced this row,
  // and how much of the scoring weight was actually selected.
  rate_table_version:       optionalText,
  family_code:              optionalText,
  // Migration 135 — the technical build-up behind the signed rate.
  blended_loss_cost_pm:     optionalNumber,
  cat_load_pm:              optionalNumber,
  risk_load_pm:             optionalNumber,
  internal_expense_pct:     optionalFraction01,
  blend_weights:            z.record(z.unknown()).optional(),
  blend_override_reason:    optionalText,
  score_completeness:       optionalFraction01,
  exposure_basis:           optionalText,

  // UI-only blob — kept passthrough-style for the dual-engine extensions
  // selection state that already lives there.
  ui_state:                 z.record(z.unknown()).optional(),

  // Migration 084 — Summary screen-owned fields
  capacity_proposed_pct:    optionalFraction01,
  accepted_rate_pm:         optionalNumber,
  uw_note:                  optionalText,
}).passthrough();


/**
 * PUT /api/fac/risks/:id/cope — COPE survey data. Lenient + passthrough:
 * coerce the typed numeric/boolean/date fields, keep everything else.
 */
export const facCopeSaveSchema = z.object({
  construction_type:        optionalText,
  construction_year:        optionalInt,
  fire_walls:               boolish,
  fire_doors:               boolish,
  spatial_separation_m:     optionalNumber,
  roof_material:            optionalText,
  wall_material:            optionalText,
  floors:                   optionalInt,
  total_area_sqm:           optionalNumber,
  occupation_description:   optionalText,
  process_description:      optionalText,
  hazard_grade:             optionalText,
  operating_hours:          optionalText,
  sprinkler_system:         boolish,
  sprinkler_type:           optionalText,
  fire_alarm:               boolish,
  fire_brigade_distance_km: optionalNumber,
  extinguishers:            boolish,
  hydrants:                 boolish,
  cctv:                     boolish,
  security_guards:          boolish,
  natcat_earthquake:        boolish,
  natcat_flood:             boolish,
  natcat_windstorm:         boolish,
  natcat_other:             optionalText,
  exposure_notes:           optionalText,
  survey_date:              isoDate,
  survey_provider:          optionalText,
  survey_rating:            optionalText,
}).passthrough();

/** One fac loss-history row. */
const facLossRowSchema = z.object({
  loss_year:           optionalInt,
  loss_date:           isoDate,
  loss_description:    optionalText,
  cause_of_loss:       optionalText,
  fgu_paid:            money,
  fgu_outstanding:     money,
  ri_paid:             money,
  ri_outstanding:      money,
  mitigation_measures: optionalText,
  is_open:             boolish,
  // Migration 135 — the underwriter's own restatement of a claim, which
  // overrides the derived index / development / as-if chain.
  indexed_incurred:    money,
  as_if_incurred:      money,
  development_factor:  optionalNumber,
  exclude_from_rating: boolish,
  exclusion_reason:    optionalText,
}).passthrough();

/** PUT /api/fac/risks/:id/losses — full loss-history replacement. */
export const facLossesSaveSchema = z.object({
  losses: z.array(facLossRowSchema).max(500).default([]),
}).passthrough();

/** POST /api/fac/risks/:id/documents — metadata-only JSON insert.
 *  `file_path` is intentionally NOT accepted here: a client must never be able
 *  to set an arbitrary document storage path via metadata (defense-in-depth on
 *  top of the readDocumentBytes SSRF hardening). Real bytes + their storage
 *  path come only from the multipart /documents/upload route. */
export const facDocumentMetaSchema = z.object({
  doc_type:    optionalText,
  file_name:   optionalText,
  file_size:   optionalInt,
  mime_type:   optionalText,
  uploaded_by: optionalText,
  notes:       optionalText,
}).passthrough();

/** POST /submit-for-approval — no body required. */
export const facSubmitForApprovalSchema = z.object({
  comment: optionalText,
}).passthrough();

/** POST /bind — effective_date optional, in ISO YYYY-MM-DD form. */
export const facBindSchema = z.object({
  effective_date: isoDate,
  // Overriding the capacity check is an act of underwriting authority, so it
  // is explicit and it carries a reason. Both go into the audit event.
  capacity_override:        z.boolean().optional(),
  capacity_override_reason: optionalText,
}).passthrough()
  .refine(
    (b) => !b.capacity_override || String(b.capacity_override_reason || '').trim().length >= 5,
    {
      path: ['capacity_override_reason'],
      message: 'A capacity override needs a reason of at least 5 characters',
    },
  );

/** POST /risks/:id/treaty-links — body schema. */
export const facTreatyLinkCreateSchema = z.object({
  contract_id:   z.string().uuid('contract_id must be a UUID'),
  link_type:     z.enum([
    'VOLUNTARY_OVER_TREATY',
    'OBLIGATORY_OUTSIDE_TREATY',
    'FAC_INSTEAD_OF_TREATY',
    'INFORMATIONAL',
  ]),
  capacity_used: money,
  notes:         optionalText,
}).passthrough();
