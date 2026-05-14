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
