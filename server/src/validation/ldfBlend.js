// Schemas for the LDF blend endpoints — preview and persist.
//
// Triangle type comes from the URL path; the bodies here describe only
// the parts the client sends.

import { z } from 'zod';
import { uuid } from './common.js';

// LDF blending only applies to the four "real" triangle types. NP_EXCESS
// (used elsewhere in the app) is intentionally excluded — those layers
// don't carry a benchmark curve.
export const ldfTriangleTypeSchema = z.enum([
  'PREMIUM', 'CLAIMS_PAID', 'CLAIMS_OS', 'INCURRED',
]);

// Override weights are an arbitrary { classOfBusinessId: weight } map.
// We can't pin the key set without round-tripping the EPI split, so we
// just constrain shape (uuid key, non-negative finite number value).
// The service re-normalises so the values don't need to sum to exactly 1.
const overrideWeightsSchema = z.record(
  uuid,
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number().nonnegative().finite(),
  ),
);

export const ldfBlendPreviewSchema = z.object({
  overrideWeights: overrideWeightsSchema.optional().nullable(),
});

const classRowSchema = z.object({
  classOfBusinessId: uuid,
  weight: z.number().nonnegative().finite(),
  scope: z.enum(['COUNTRY', 'REGION', 'GLOBAL', 'NONE']),
  nContracts: z.number().int().nonnegative(),
});

const curveRowSchema = z.object({
  devMonth: z.number().int().nonnegative(),
  ldf: z.number().positive().finite(),
  cdf: z.number().positive().finite(),
});

export const ldfBlendSaveSchema = z.object({
  overridden: z.boolean(),
  classes: z.array(classRowSchema).min(1),
  blended: z.array(curveRowSchema).min(1),
});
