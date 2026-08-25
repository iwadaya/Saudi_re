// server/src/validation/retro.js
// Zod schemas for the Retro module (/api/retro/*). Composed from
// validation/common.js primitives so UUID/money rules stay consistent
// with the rest of the API surface.

import { z } from 'zod';
import { uuid } from './common.js';

export const RETRO_PROGRAMME_TYPES = [
  'QUOTA_SHARE', 'SURPLUS', 'XL_PER_RISK', 'XL_CAT',
  'XL_AGGREGATE', 'STOP_LOSS', 'WHOLE_ACCOUNT_XL', 'OTHER',
];
export const RETRO_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'CANCELLED'];

const isoDate = z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
  },
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date').optional(),
);

const money = z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : v;
  },
  z.number().min(0, 'must be ≥ 0').max(1e18).optional(),
);

const pctBase = (max) => z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const n = Number(String(v).replace(/[%,\s]/g, ''));
    return Number.isFinite(n) ? n : v;
  },
  z.number().min(0).max(max).optional(),
);
const pct = pctBase(100);
const pct200 = pctBase(200);

const intNonNeg = z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : v;
  },
  z.number().int().min(0).max(99).optional(),
);

const optionalText = (max) => z.preprocess(
  (v) => (v === '' || v == null ? undefined : (typeof v === 'string' ? v.trim() : v)),
  z.string().max(max).optional(),
);

const uuidArray = z.array(uuid).max(500).default([]);

const regionArray = z.array(z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().min(1).max(120),
)).max(100).default([]);

// One layer of a non-proportional retro tower. layer_number is assigned
// server-side from array order, so the client sends terms only.
const layerSchema = z.object({
  attachment: money,
  occurrence_limit: money,
  aggregate_limit: money,
  reinstatements: intNonNeg,
  reinstatement_pct: pct200,
  rol_pct: pct,
  premium: money,
  notes: optionalText(1000),
}).strict();

// ── POST /api/retro/programmes ───────────────────────────────────────────────
export const retroProgrammeCreateSchema = z.object({
  uw_year: z.preprocess((v) => Number(v), z.number().int().min(1990).max(2100)),
  programme_name: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string().min(1, 'programme name is required').max(200),
  ),
  programme_type: z.enum(RETRO_PROGRAMME_TYPES).default('XL_PER_RISK'),
  status: z.enum(RETRO_STATUSES).default('DRAFT'),
  reinsurer: optionalText(300),
  currency_code: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : undefined),
    z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code').default('USD'),
  ),
  cession_pct: pct,
  commission_pct: pct,
  attachment: money,
  occurrence_limit: money,
  aggregate_limit: money,
  reinstatements: intNonNeg,
  rol_pct: pct,
  premium: money,
  inception_date: isoDate,
  expiry_date: isoDate,
  covers_all_classes: z.boolean().default(false),
  covers_all_countries: z.boolean().default(false),
  notes: optionalText(4000),
  class_of_business_ids: uuidArray,
  country_ids: uuidArray,
  regions: regionArray,
  layers: z.array(layerSchema).max(30).default([]),
}).strict();

// ── PUT /api/retro/programmes/:id ────────────────────────────────────────────
// Same shape, everything optional — only supplied fields are updated; the
// scope arrays, when supplied, REPLACE the existing scope.
export const retroProgrammeUpdateSchema = retroProgrammeCreateSchema.partial().strict();
