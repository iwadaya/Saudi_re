// server/src/validation/retroProgramme.js
// Body schema for the admin-maintained outward retro contract.
// Composed from validation/common.js primitives.

import { z } from 'zod';
import { money, pct100 } from './common.js';

/** Required underwriting year — the programme's key, so it may not be absent. */
const requiredUwYear = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}, z.number({ required_error: 'uw_year is required' }).int().min(1900).max(2200));

/** ISO currency code, upper-cased. */
const currencyCode = z.preprocess(
  (v) => (v === null || v === undefined || v === '' ? undefined : String(v).trim().toUpperCase()),
  z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code').default('USD'),
);

const optionalDate = z.preprocess((v) => {
  if (!v) return undefined;
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional());

const optionalText = z.preprocess(
  (v) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim().slice(0, 500)),
  z.string().optional(),
);

/** Line ceiling for the optimiser — a programme that allows 0% is a typo. */
const maxLinePct = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(String(v).replace(/[%, ]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().gt(0).max(100).optional());

export const retroProgrammeSchema = z.object({
  uw_year: requiredUwYear,
  currency: currencyCode,
  label: optionalText,
  reinsurer: optionalText,
  inception_date: optionalDate,
  expiry_date: optionalDate,
  retention_amt: money,
  limit_amt: money,
  rol_pct: pct100,
  used_limit_amt: money,
  cession_pct: pct100,
  commission_pct: pct100,
  max_line_pct: maxLinePct,
  notes: optionalText,
  is_active: z.preprocess((v) => (v === undefined || v === null || v === '' ? undefined : v === true || v === 'true'), z.boolean().optional()),
}).strict();
