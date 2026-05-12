// server/src/validation/triangle.js
// Schemas for the triangle and dev-factor save endpoints. The cells
// schema validates the *normalized* array produced by
// normalizeTriangleRequest — each route normalises the multi-shape
// wire body first and then runs the strict per-cell schema, so
// downstream code can rely on { origin_year, dev_months, cum_value }
// being well-formed even though the wire shape is union-typed.

import { z } from 'zod';

// triangle_type enum values from migrations 000/038/040/047. Kept in
// sync by hand — there's no programmatic export from the DB.
export const triangleTypeSchema = z.enum([
  'PREMIUM', 'CLAIMS_PAID', 'CLAIMS_OS', 'INCURRED', 'NP_EXCESS',
]);

// Reasonable origin-year bounds. The DB column is a plain int but
// experience/inception years for live treaties live in the 1900–2100
// window; anything outside is almost certainly a wire error (e.g.
// dev_months and origin_year swapped).
const originYear = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().int().gte(1900).lte(2100),
);

// dev_months should be a positive multiple of 12 (yearly grid). The
// upstream filter caps the grid at 60 dev years, so 720 is the
// hard ceiling. We also accept 0 because some imports send the at-
// inception column as dev_months=0 — the bounds filter drops it
// later, but it's not malformed per-se.
const devMonths = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().int().gte(0).lte(720),
);

// Cumulative cell value: a finite number or null (null = no data
// for this cell). Negative values are legal — claims paid/OS can
// be negative after recoveries.
const cumValue = z.preprocess(
  (v) => (v === '' || v == null ? null : Number(v)),
  z.number().finite().nullable(),
);

export const triangleCellSchema = z.object({
  origin_year: originYear,
  dev_months: devMonths,
  cum_value: cumValue,
}).passthrough();

export const triangleCellsSchema = z.array(triangleCellSchema);

// Dev factor row. Most numeric fields are nullable because the UI
// emits sparse rows (only the chosen source is required to have a
// value); the others are display-only carry-throughs. We bound the
// LDF to a sane window — values outside [0.5, 50] are almost always
// data entry errors at the cell level.
const ldfNum = z.preprocess(
  (v) => (v === '' || v == null ? null : Number(v)),
  z.number().finite().gte(0).lte(50).nullable(),
);

const cdfNum = z.preprocess(
  (v) => (v === '' || v == null ? null : Number(v)),
  z.number().finite().gte(0).lte(1000).nullable(),
);

const chosenSource = z
  .enum(['SELECTED', 'ACTUAL', 'PARAM', 'PARAMETRIZED', 'BENCHMARK', 'OVERRIDE', 'LINK_RATIO'])
  .nullable()
  .optional();

export const devFactorRowSchema = z.object({
  dev_month: z.preprocess(
    (v) => (v === '' || v == null ? undefined : Number(v)),
    z.number().int().gte(0).lte(720),
  ),
  selected_ldf: ldfNum.optional(),
  selected_cdf: cdfNum.optional(),
  actual_ldf: ldfNum.optional(),
  actual_cdf: cdfNum.optional(),
  param_ldf: ldfNum.optional(),
  param_cdf: cdfNum.optional(),
  parametrized_ldf: ldfNum.optional(),
  parametrized_cdf: cdfNum.optional(),
  chosen_ldf: ldfNum.optional(),
  chosen_cdf: cdfNum.optional(),
  chosen_source: chosenSource,
  overridden: z.boolean().optional(),
}).passthrough();

export const devFactorPutSchema = z.object({
  factors: z.array(devFactorRowSchema).default([]),
  method: z.string().max(64).nullable().optional(),
  _actor: z.string().max(120).optional(),
}).passthrough();
