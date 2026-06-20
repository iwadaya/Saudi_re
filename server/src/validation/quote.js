// server/src/validation/quote.js
// Zod schemas for the quote save endpoints. Apply via validateBody()
// from server/src/lib/validate.js.
//
// Naming: each schema mirrors the wire shape. We use .partial() on
// nested groups because the PUT /quotes/:id endpoint is partial-save —
// the client sends only the slices it changed.

import { z } from 'zod';
import {
  optionalUuid, money, pct100, pctOpen, uwYear, isoDate, boolish, contractStatus,
} from './common.js';

/** A signed number that accepts strings with commas (losses can be negative). */
const signedNumber = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().optional());

/** Header slice — top-level FKs + UW year + status. */
export const quoteHeaderSchema = z.object({
  cedant_id:        optionalUuid,
  broker_id:        optionalUuid,
  currency_id:      optionalUuid,
  country_id:       optionalUuid,
  treaty_type_id:   optionalUuid,
  uw_year:          uwYear,
  status:           contractStatus.optional(),
  // Matches Postgres CHECK on experience_source — see treaty.js.
  experience_source: z.enum(['TRIANGLE', 'STRAIGHT']).optional(),
  renewal_date:     isoDate,
  inception_date:   isoDate,
  contract_description: z.string().nullable().optional(),
}).passthrough();

/** Detail slice — proportional treaty terms. */
export const quoteDetailSchema = z.object({
  triangulations_available: boolish,
  inception_date:           isoDate,
  renewal_date:             isoDate,
  experience_start_year:    uwYear,
  qs_limit:                 money,
  retention_pct:            pct100,
  retention_amt:            money,
  cession_pct:              pct100,
  cession_amt:              money,
  surplus_max_retention:    money,
  num_lines:                z.preprocess(v => v === '' || v == null ? undefined : Number(v),
                            z.number().int().nonnegative().optional()),
  total_capacity:           money,
  event_limit:              money,
  aal:                      money,
  quota_share_epi:          money,
  surplus_epi:              money,
  brokerage_pct:            pct100,
  taxes_pct:                pct100,
  loss_cap_pct:             pctOpen,
}).passthrough();

/** Commission slice. */
export const quoteCommissionsSchema = z.object({
  // Matches Postgres commission_mode enum — FIXED or SLIDING only.
  mode:                          z.enum(['FIXED', 'SLIDING']).optional(),
  fixed_commission_pct:          pct100,
  fixed_commission_qs_pct:       pct100,
  fixed_commission_surplus_pct:  pct100,
  provisional_commission_pct:    pct100,
  provisionalCommissionPct:      pct100,
  sliding_min_loss_ratio:        pct100,
  sliding_max_loss_ratio:        pct100,
  sliding_min_commission:        pct100,
  sliding_max_commission:        pct100,
  mgmt_expenses_pct:             pct100,
  profit_commission_pct:         pct100,
  sliding_table:                 z.array(z.unknown()).optional(),
  // Loss Carry Forward — see treaty.js commission schema for full
  // explanation. Mirrored here so quotes validate the same shape.
  lcf_years:                     z.number().int().min(0).max(20).nullable().optional(),
  lcf_extinction:                boolish,
}).passthrough();

/**
 * One loss-participation corridor row. Mirrors treaty schema so quote
 * payloads validate identically. Quote PUT doesn't persist slides yet
 * (separate tightening target) but the payload contract is symmetric.
 */
const lpSlideSchema = z.object({
  min_lr:  pct100,
  max_lr:  pct100,
  share:   pct100,
  minLr:   pct100,
  maxLr:   pct100,
}).passthrough().refine(
  s => {
    const min = s.min_lr ?? s.minLr;
    const max = s.max_lr ?? s.maxLr;
    return min == null || max == null || Number(max) > Number(min);
  },
  { message: 'max_lr must be greater than min_lr' }
);

/** Loss participation slice. */
export const quoteLossParticipationSchema = z.object({
  enabled:               boolish,
  min_loss_ratio_pct:    pct100,
  max_loss_ratio_pct:    pct100,
  reinsurer_share_pct:   pct100,
  // Camel-case aliases the client sometimes sends — kept for compat
  minLossRatioPct:       pct100,
  maxLossRatioPct:       pct100,
  reinsurerSharePct:     pct100,
  slides:                z.array(lpSlideSchema).max(5).optional(),
}).passthrough();

/**
 * The full PUT /quotes/:id body. Every key is optional so the client
 * can send just the slices it changed (the long-standing partial-save
 * convention).
 */
export const quotePutBodySchema = z.object({
  terms: z.object({
    header:             quoteHeaderSchema.optional(),
    detail:             quoteDetailSchema.optional(),
    commissions:        quoteCommissionsSchema.optional(),
    classIds:           z.array(z.string().uuid()).optional(),
    class_ids:          z.array(z.string().uuid()).optional(),
    epi_split:          z.array(z.unknown()).optional(),
    epiSplit:           z.array(z.unknown()).optional(),
    lossParticipation:  quoteLossParticipationSchema.optional(),
    loss_participation: quoteLossParticipationSchema.optional(),
    np_final_pricing:   z.unknown().optional(), // free-form JSONB; deeper schema TBD
    np_structure:       z.unknown().optional(),
  }).default({}),
});

// ── Subresource save schemas (P1-validation) ────────────────────────────────
// Lenient + passthrough, matching the partial-save convention above: validate
// types/shape and coerce known fields, reject obviously-malformed payloads
// (non-UUID ids, non-array collections) BEFORE they reach the DB layer.

/** PUT /quotes/:id/strip-large-cat — the strip toggle. */
export const stripLargeCatSchema = z.object({
  strip_large_cat_losses: boolish,
  stripLargeCatLosses:    boolish, // camelCase alias the client sometimes sends
}).passthrough();

/** One large/cat-loss register row. All fields optional; the client may send partial rows. */
export const lossRowSchema = z.object({
  loss_id:                 optionalUuid,
  uw_year:                 uwYear,
  insured_name:            z.string().nullable().optional(),
  loss_name:               z.string().nullable().optional(),
  class_of_business:       z.string().nullable().optional(),
  date_of_loss:            isoDate,
  reported_date:           isoDate,
  actuarial_reported_date: isoDate,
  policy_inception_date:   isoDate,
  paid:                    signedNumber,
  os:                      signedNumber,
  incurred:                signedNumber,
  is_selected:             boolish,
  inflation_factor:        z.preprocess(
                             v => (v === '' || v == null ? undefined : Number(v)),
                             z.number().optional()),
}).passthrough();

/** PUT /quotes/:id/large-losses and /cat-losses — shared register payload. */
export const lossesSaveSchema = z.object({
  report_date: isoDate,
  losses:      z.array(lossRowSchema).max(5000).default([]),
}).passthrough();

/** PUT /quotes/:id/cobs — class-of-business selection. */
export const cobsSaveSchema = z.object({
  class_ids: z.array(z.string().uuid()).optional(),
  classIds:  z.array(z.string().uuid()).optional(),
}).passthrough();

/** One exposure/claims band row. */
const profileBandSchema = z.object({
  from_amt:          money,
  to_amt:            money,
  no_of_risks:       signedNumber,
  total_sum_insured: money,
  gross_premium:     money,
  no_of_claims:      signedNumber,
  aggregate_incurred: signedNumber,
}).passthrough();

/** PUT /quotes/:id/risk-profiles/:cobId — exposure curve + bands. */
export const riskProfileSaveSchema = z.object({
  c_value:          signedNumber,
  pml_percentage:   pctOpen,
  selected_curve:   z.string().nullable().optional(),
  custom_b:         signedNumber,
  custom_g:         signedNumber,
  gross_loss_ratio: pctOpen,
  bands:            z.array(profileBandSchema).max(1000).default([]),
}).passthrough();

/** PUT /quotes/:id/claims-profiles/:cobId — claims curve + bands. */
export const claimsProfileSaveSchema = z.object({
  selected_curve: z.string().nullable().optional(),
  custom_b:       signedNumber,
  custom_g:       signedNumber,
  bands:          z.array(profileBandSchema).max(1000).default([]),
}).passthrough();
