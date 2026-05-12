// server/src/validation/treaty.js
// Zod schemas for the treaty save endpoints. Mirrors quote.js; the
// shared primitives live in common.js.
//
// We keep quote and treaty schemas separate (rather than one shared
// definition) because:
//   1. They can drift legitimately — e.g. a treaty-only uw_status
//      column, a quote-only quote_ref — and we'd rather notice via
//      explicit divergence than magic conditionals.
//   2. Per-endpoint schemas are easier to evolve: tighten quote first,
//      treaty later, without risk of breaking one while fixing the
//      other.

import { z } from 'zod';
import {
  optionalUuid, money, pct100, pctOpen, uwYear, isoDate, boolish, contractStatus,
} from './common.js';

/** Uw workflow status — separate from the generic contract status. */
const uwWorkflowStatus = z.enum([
  'DRAFT', 'WAITING_APPROVAL', 'APPROVED', 'AWAITING_SIGNED_LINE',
  'SIGNED', 'NTU', 'DECLINED',
]).optional();

/** Header slice — identical to quote's plus uw_status. */
export const treatyHeaderSchema = z.object({
  cedant_id:        optionalUuid,
  broker_id:        optionalUuid,
  currency_id:      optionalUuid,
  country_id:       optionalUuid,
  treaty_type_id:   optionalUuid,
  uw_year:          uwYear,
  status:           contractStatus.optional(),
  uw_status:        uwWorkflowStatus,
  // Matches the DB CHECK on contract.experience_source — just two
  // values. Earlier drafts listed HISTORICAL/BURN that don't exist
  // in the DB and rejected STRAIGHT which does.
  experience_source: z.enum(['TRIANGLE', 'STRAIGHT']).optional(),
  renewal_date:     isoDate,
  inception_date:   isoDate,
  signed_line_pct:  pct100,
  contract_description: z.string().nullable().optional(),
  primary_class_of_business_id: optionalUuid,
}).passthrough();

/** Detail slice — proportional treaty terms (same shape as quote). */
export const treatyDetailSchema = z.object({
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
export const treatyCommissionsSchema = z.object({
  // Matches Postgres commission_mode enum — FIXED or SLIDING only.
  // 'PROFIT' was a phantom left over from an earlier draft; no
  // client ever sends it, and the DB would reject it.
  mode:                          z.enum(['FIXED', 'SLIDING']).optional(),
  fixed_commission_pct:          pct100,
  fixed_commission_qs_pct:       pct100,
  fixed_commission_surplus_pct:  pct100,
  provisional_commission_pct:    pct100,
  sliding_min_loss_ratio:        pct100,
  sliding_max_loss_ratio:        pct100,
  sliding_min_commission:        pct100,
  sliding_max_commission:        pct100,
  mgmt_expenses_pct:             pct100,
  profit_commission_pct:         pct100,
  sliding_table:                 z.array(z.unknown()).optional(),
  // Loss Carry Forward — number of years the underwriting deficit
  // rolls forward into next year's profit-commission base, with
  // optional extinction at the end of the carry-forward window.
  // Persisted to contract_commissions.lcf_years / lcf_extinction
  // (added by migration 040) but absent from this schema until now,
  // which meant invalid values slipped through .passthrough().
  lcf_years:                     z.number().int().min(0).max(20).nullable().optional(),
  lcf_extinction:                boolish,
}).passthrough();

/** Loss participation slice. */
export const treatyLossParticipationSchema = z.object({
  enabled:               boolish,
  min_loss_ratio_pct:    pct100,
  max_loss_ratio_pct:    pct100,
  reinsurer_share_pct:   pct100,
  minLossRatioPct:       pct100,
  maxLossRatioPct:       pct100,
  reinsurerSharePct:     pct100,
}).passthrough();

/**
 * PUT /treaties/:id body. Every slice optional (partial-save). The
 * save_mode accepts 'MANUAL' or 'AUTO' but is used purely for audit
 * hints so the handler can keep whatever it wants.
 */
export const treatyPutBodySchema = z.object({
  terms: z.object({
    header:             treatyHeaderSchema.optional(),
    detail:             treatyDetailSchema.optional(),
    commissions:        treatyCommissionsSchema.optional(),
    classIds:           z.array(z.string().uuid()).optional(),
    class_ids:          z.array(z.string().uuid()).optional(),
    epi_split:          z.array(z.unknown()).optional(),
    epiSplit:           z.array(z.unknown()).optional(),
    underwriting_limits: z.array(z.unknown()).optional(),
    underwritingLimits: z.array(z.unknown()).optional(),
    event_loss_tables:  z.unknown().optional(),
    lossParticipation:  treatyLossParticipationSchema.optional(),
    loss_participation: treatyLossParticipationSchema.optional(),
    np_final_pricing:   z.unknown().optional(),
    np_structure:       z.unknown().optional(),
  }).passthrough().default({}),
  // save_mode is a client-only audit marker, not persisted to a DB
  // enum. Kept as a loose string so future values (e.g. 'AUTOSAVE')
  // don't 400 saves before the schema catches up.
  save_mode: z.string().max(32).optional(),
});
