// server/src/validation/nonProp.js
// Zod schemas for the non-proportional write endpoints. Previously
// these accepted any shape; a typo (e.g. `uwyear` vs `uw_year`) would
// silently land as NULL in the DB with no error surfaced.
//
// Same philosophy as pricing.js: .passthrough() objects, coerce
// number-ish fields, reject clearly wrong shapes. We do NOT enforce
// required fields the handler is tolerant of (e.g. `detail` may be
// omitted entirely from the NP save).

import { z } from 'zod';
import { uuid, uwYear, money, pct100, pctOpen } from './common.js';
import { primitives } from './pricing.js';

const { numish } = primitives;

// Layer / expiring-layer count. Bounded so garbage (4.5, 1e12) is rejected
// with a field message instead of failing the INSERT into an integer column.
const layerCount = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().int().min(0).max(50).optional());

// ─── Layer (NP excess-of-loss structure) ──────────────────────────
// Matches the columns of contract_np_layers. All numeric fields are
// optional because the UI persists partial drafts.
const npLayerSchema = z.object({
  layer_number:          z.number().int().min(1).max(50),
  attachment:            numish,
  layer_limit:           numish,
  aggregate_limit:       numish,
  egnpi:                 numish,
  earned_premium:        numish,
  rate:                  numish,
  rol:                   numish,
  num_reinstatements:    numish,
  // numeric(5,2) column — an unbounded value (e.g. a fat-fingered 1010) used
  // to surface as a raw Postgres overflow. pctOpen allows >100% market terms
  // (e.g. "1 @ 125%") while rejecting garbage.
  reinstatement_pct:     pctOpen,
  annual_agg_deductible: numish,
  peril_scope:           z.enum(['RISK', 'CAT', 'BOTH']).optional(),
  mdp:                   numish,
  mdp_pct:               numish,
  hist_margin:           numish,
  modelled_margin:       numish,
  tech_ratio:            numish,
  uw_price:              numish,
  expiring_price:        numish,
  lead_price:            numish,
  class_of_business_ids: z.array(uuid).optional(),
}).passthrough();

// ─── Terms envelope (free-form JSONB) ─────────────────────────────
const termsObject = z.object({}).passthrough();

/**
 * POST /api/treaties/:id/non-prop/save
 *
 * Composite save of NP detail + layers + terms + per-COB underwriting
 * limits. Every top-level key is optional; the handler only does work
 * for keys that are present.
 */
export const npSaveSchema = z.object({
  detail: z.object({
    number_of_layers:           layerCount,
    expiring_number_of_layers:  layerCount,
    deductible:                 money,
    max_retention:              money,
    accounting_method:          z.string().optional(),
    xl_type:                    z.string().optional(),
    accounts:                   z.string().optional(),
    // Percent columns are numeric(5,2) — before these bounds, an out-of-range
    // value (e.g. brokerage_pct 1010 from a mangled input) reached Postgres
    // and came back as a raw `numeric field overflow` 500.
    brokerage_pct:              pct100,
    taxes_pct:                  pct100,
    no_claims_bonus_pct:        pct100,
    profit_commission_pct:      pct100,
    est_gnpi:                   money,
    adjustment_rate:            numish,
    deposit_premium:            money,
    experience_start_year:      uwYear,
    experienceStartYear:        uwYear,     // legacy camelCase alias the handler still accepts
  }).passthrough().optional(),
  layers: z.array(npLayerSchema).optional(),
  terms:  termsObject.optional(),
  cob_underwriting_limits: z.array(z.object({
    cob_id:       uuid,
    limit_amount: numish,
  }).passthrough()).optional(),
}).passthrough();

/**
 * PUT /api/treaties/:id/np/egnpi-year
 *
 * Replaces the per-year EGNPI / inflation rows for a contract.
 */
export const egnpiYearPutSchema = z.object({
  rows: z.array(z.object({
    uw_year:         uwYear,
    egnpi:           numish,
    inflation_pct:   numish,
    rate_change_pct: numish, // per-year rate change for on-level adjustment
  }).passthrough()).default([]),
}).passthrough();

/**
 * PUT /api/treaties/:id/np-pricing
 *
 * Saves the three NP pricing tables in one request. Every sub-array
 * is optional; the handler iterates each independently.
 */
export const npPricingPutSchema = z.object({
  inputs: z.object({
    burn_weight_pct:     numish,
    exposure_weight_pct: numish,
    pareto_weight_pct:   numish,
    pricing_loading_pct: numish,
    swiss_re_curve_name: z.string().optional(),
  }).passthrough().optional(),
  layer_inputs: z.array(z.object({
    layer_number:          z.number().int().min(1).max(50),
    expiring_pricing_pct:  numish,
  }).passthrough()).optional(),
  outputs: z.array(z.object({
    layer_number: z.number().int().min(1).max(50),
    section:      z.enum(['RISK', 'CAT']),
  }).passthrough()).optional(),
  layer_margins: z.array(z.object({
    layer_number: z.number().int().min(1).max(50),
  }).passthrough()).optional(),
}).passthrough();

/**
 * PUT /api/quotes/:id/np-pricing
 *
 * Mirrors npPricingPutSchema, but `quote_np_pricing_outputs` has NO section
 * CHECK constraint (contract_np_pricing_outputs restricts it to RISK/CAT — see
 * migration 000). Quote pricing legitimately carries other section labels (e.g.
 * 'AS_IF'), so the quote variant validates `section` as a lenient short string
 * rather than the treaty enum.
 */
export const quoteNpPricingPutSchema = npPricingPutSchema.extend({
  outputs: z.array(z.object({
    layer_number: z.number().int().min(1).max(50),
    section:      z.string().min(1).max(40),
  }).passthrough()).optional(),
});

/**
 * PUT /api/{treaties|quotes}/:id/np/expiring
 *
 * Shared handler; layers + terms are the same shape as the NP save
 * but this endpoint also carries the coveredProps free-form list.
 * The integration test already exercises this path — our schema
 * must accept every shape that test sends.
 */
export const npExpiringPutSchema = z.object({
  layers:       z.array(z.object({
    layer_number:          z.number().int().min(1).max(50),
    attachment:            numish,
    layer_limit:           numish,
    aggregate_limit:       numish,
    egnpi:                 numish,
    earned_premium:        numish,
    rate:                  numish,
    rol:                   numish,
    num_reinstatements:    numish,
    reinstatement_pct:     numish,
    annual_agg_deductible: numish,
    peril_scope:           z.enum(['RISK', 'CAT', 'BOTH']).optional(),
    mdp:                   numish,
    mdp_pct:               numish,
  }).passthrough()).default([]),
  terms:        z.object({
    egnpi:                  numish,
    deductible:             numish,
    risk_limit:             numish,
    cat_limit:              numish,
    brokerage_pct:          numish,
    no_claims_bonus_pct:    numish,
    profit_commission_pct:  numish,
    // .nullish() accepts null AND undefined. The client sends `notes: null`
    // explicitly when the field is cleared, and .optional() alone rejected it.
    notes:                  z.string().nullish(),
  }).passthrough().default({}),
  coveredProps: z.array(z.any()).optional(),
}).passthrough();

/**
 * PUT /api/{treaties|quotes}/:id/np/excess-ldfs
 *
 * Stores per-dev-month loss-development factors. Sources are free-text
 * labels (e.g. "chain_ladder", "manual"); we keep them as strings.
 */
export const excessLdfsPutSchema = z.object({
  factors: z.array(z.object({
    dev_month:        z.number().int().min(0).max(600),
    chosen_source:    z.string().optional(),
    chosen_ldf:       numish,
    chosen_cdf:       numish,
    actual_ldf:       numish,
    actual_cdf:       numish,
    param_ldf:        numish,
    param_cdf:        numish,
    parametrized_ldf: numish,  // legacy alias
    parametrized_cdf: numish,  // legacy alias
  }).passthrough()).default([]),
  tail_factor: numish,
}).passthrough();

/**
 * PUT /api/{treaties|quotes}/:id/np/{large-loss|cat-loss}-ldfs
 *
 * Per-loss-type LDF/CDF factors + the developed-ultimate table. Generated for
 * both loss types by makeLossLdfRoutes(); the handler reads `year|acc_year`,
 * `count|loss_count` and `cdf|applied_cdf` aliases, so all are accepted.
 */
export const lossLdfsPutSchema = z.object({
  ldfs: z.array(z.object({
    dev_month:  z.number().int().min(0).max(600),
    chosen_ldf: numish,
    chosen_cdf: numish,
  }).passthrough()).default([]),
  ultimates: z.array(z.object({
    year:        uwYear,
    acc_year:    uwYear,
    count:       numish,
    loss_count:  numish,
    reported:    numish,
    cdf:         numish,
    applied_cdf: numish,
    ibnr:        numish,
    ultimate:    numish,
  }).passthrough()).default([]),
  tail_factor: numish,
}).passthrough();

/**
 * PUT /api/treaties/:id/np/historical-performance
 *
 * Replaces the historical performance rows for a contract.
 */
export const historicalPerfPutSchema = z.object({
  rows: z.array(z.object({
    uw_year:        uwYear,
    premiums:       numish,
    claims:         numish,
    egnpi:          numish,
    result:         numish,
    loss_ratio:     numish,
    expense_ratio:  numish,
    combined_ratio: numish,
  }).passthrough()).default([]),
}).passthrough();

/**
 * PUT /api/{treaties|quotes}/:id/np/stop-loss-pricing
 *
 * Persists the underwriter's Stop Loss / Aggregate XL pricing
 * inputs (and a snapshot of the resolved outputs) for replay across
 * sessions. We accept the full screen state as JSON rather than
 * normalised rows — the input shape evolves with the engine and
 * passthrough() keeps it forward-compatible with new fields.
 */
export const stopLossPricingPutSchema = z.object({
  inputs:  z.record(z.unknown()).default({}),
  outputs: z.record(z.unknown()).optional().nullable(),
}).passthrough();
