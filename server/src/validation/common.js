// server/src/validation/common.js
// Reusable Zod primitives that match the column types in our schema.
// Centralised so the same string-vs-uuid, money-vs-pct rules live in
// one place — schema authors compose these instead of redefining.

import { z } from 'zod';

/** UUID-as-string with a clear error message. */
export const uuid = z.string().uuid('must be a UUID');

/** Optional UUID — null/undefined/empty all become undefined. */
export const optionalUuid = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().uuid('must be a UUID').optional(),
);

/** Bigint-safe non-negative number that accepts strings with commas. */
export const money = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().nonnegative().optional());

/** Percentage stored as a number 0..100 (NOT a fraction). */
export const pct100 = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[%, ]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().min(0).max(100).optional());

/**
 * Percentage that may legitimately exceed 100% — e.g. a treaty loss
 * cap, where 130% / 150% / 200% are common ("cap claims at X% of
 * premium"). Capped at 1000 to still catch obvious typos.
 */
export const pctOpen = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[%, ]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}, z.number().min(0).max(1000).optional());

/** Optional integer year. */
export const uwYear = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}, z.number().int().min(1900).max(2200).optional());

/** Date — ISO YYYY-MM-DD or longer. Returns the YYYY-MM-DD prefix. */
export const isoDate = z.preprocess((v) => {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Accept Date-parseable strings too
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional());

/** Boolean coercion that accepts "true"/"false"/1/0. */
export const boolish = z.preprocess((v) => {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}, z.boolean().optional());

/**
 * `contract_status` Postgres enum (the 11-value one on contract.status
 * and quote.status). Shares AWAITING_APPROVAL with uwWorkflowStatus
 * but carries QUOTED, BOUND, RENEWED, CANCELLED, OFFERED on top.
 *
 * Schemas should pick the right one for whichever column the field
 * maps to — an earlier revision aliased both to the 7-value list and
 * broke saves that sent `status: 'AWAITING_APPROVAL'`.
 */
export const contractStatus = z.enum([
  'DRAFT', 'QUOTED', 'AWAITING_APPROVAL', 'BOUND', 'RENEWED', 'CANCELLED',
  'AWAITING_SIGNED_LINE', 'OFFERED', 'DECLINED', 'SIGNED', 'NTU',
]);

/**
 * `uw_workflow_status` Postgres enum — the 7-value underwriting
 * lifecycle on contract.uw_status. Separate from contractStatus.
 */
export const uwWorkflowStatus = z.enum([
  'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_SIGNED_LINE',
  'SIGNED', 'NTU', 'DECLINED',
]);
