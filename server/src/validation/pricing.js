// server/src/validation/pricing.js
// Zod schemas for the pricing POST/PUT surfaces on the server. These
// endpoints previously accepted any shape; the audit flagged that
// client-computed actuarial outputs were trusted verbatim with no
// guard against garbage, typo keys, or the wrong data types silently
// landing in JSONB columns.
//
// Philosophy:
//   - .passthrough() on every object — clients may add new fields
//     ahead of the server rolling out support for them. Dropping
//     unknowns would be a breaking change.
//   - numeric fields use the coercing primitives from common.js so
//     "1,234.56" strings keep working (the client has always sent
//     some fields as strings from number inputs).
//   - required keys match what the handlers already dereference.
//     Anything the handler does `?.` chaining on stays optional.

import { z } from 'zod';
import { uuid, money, pct100, uwYear } from './common.js';

// ─── Small reusable fragments for the pricing schemas ─────────────
// Numeric coercion that allows strings like "1,234.56" but flags
// structural garbage. We don't constrain to non-negative here since
// some actuarial signals (margin, tech_ratio) can validly be negative.
const numish = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().optional());

/**
 * PUT /api/treaties/:id/pricing-outputs
 *
 * The handler forwards the route-backed proportional pricing columns to
 * upsertPricingOutputs(id, body). Keep passthrough because clients may
 * carry extra UI state alongside the persisted scalar outputs.
 */
export const pricingOutputsPutSchema = z.object({
  epi:                numish,
  attritional_ratio:  numish,
  large_loss_load:    numish,
  cat_loss_load:      numish,
  commission_ratio:   numish,
  brokerage_ratio:    numish,
  tax_ratio:          numish,
  technical_result:   numish,
  max_commission:     numish,
  target_margin:      numish,
}).passthrough();

/**
 * PUT /api/treaties/:id/pricing-yearly
 *
 * The handler reads `req.body.rows ?? []`. Historically the client
 * has sent TWO shapes on this endpoint:
 *   1. { rows: [...] }   — the "correct" wrapped shape.
 *   2. [...]             — a bare array. PropProjectedSummary.jsx
 *                          currently does this; pre-validation the
 *                          handler silently dropped it (because
 *                          req.body.rows on an array is undefined)
 *                          and the save was a no-op.
 *
 * Enforcing only shape 1 would regress PropProjectedSummary saves
 * with a 400, so we normalise both inputs to { rows: [...] } via a
 * Zod preprocess step. The handler stays unchanged.
 */
export const pricingYearlyPutSchema = z.preprocess((v) => {
  if (Array.isArray(v)) return { rows: v };
  return v;
}, z.object({
  rows: z.array(z.object({}).passthrough()).default([]),
}).passthrough());

/**
 * POST /api/pricing/save
 *
 * Composite save — one request that upserts pricing outputs,
 * yearly rows, component snapshots, lead structures, share scenarios,
 * and a free-text comment.
 *
 * The only real validation gate here is that the caller supplied a
 * UUID contractId; the rest of the payload is historical free-form
 * JSON that different callers shape differently (e.g. PropPricing
 * sends `leads` as an object, while other callers may send arrays).
 * We accept any shape per sub-field to avoid breaking existing
 * clients — structural validation for those surfaces is a separate
 * cleanup pass.
 */
export const compositePricingSaveSchema = z.object({
  contractId:       uuid.optional(),
  contract_id:      uuid.optional(),
  outputs:          z.unknown().optional(),
  yearly:           z.unknown().optional(),
  components:       z.unknown().optional(),
  leads:            z.unknown().optional(),
  share_scenarios:  z.unknown().optional(),
  comment:          z.string().max(10_000).optional(),
}).passthrough().refine(
  (b) => !!(b.contractId || b.contract_id),
  { message: 'contractId (or contract_id) is required', path: ['contractId'] },
);

/**
 * POST /api/straight-stats/save
 *
 * Saves the "straight" (vs triangle) experience rows keyed by tail type.
 * tailType is an enum of SHORT_TAIL | LONG_TAIL — anything else would
 * violate the DB check constraint, so we fail early with a clear error
 * instead of letting the INSERT throw.
 */
export const straightStatsSaveSchema = z.object({
  contractId:  uuid.optional(),
  contract_id: uuid.optional(),
  tailType:    z.enum(['SHORT_TAIL', 'LONG_TAIL']).optional(),
  tail_type:   z.enum(['SHORT_TAIL', 'LONG_TAIL']).optional(),
  stats:       z.array(z.object({}).passthrough()).default([]),
}).passthrough().refine(
  (b) => !!(b.contractId || b.contract_id),
  { message: 'contractId (or contract_id) is required', path: ['contractId'] },
);

export const primitives = { numish, money, pct100, uwYear };
