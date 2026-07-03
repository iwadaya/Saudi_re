// server/src/validation/claims.js
// Zod schemas for the Claims module (/api/claims/*) and Finance module
// (/api/finance/*) routes. Composed from validation/common.js primitives so
// UUID/money/date rules stay consistent with the rest of the API surface.

import { z } from 'zod';
import { uuid, optionalUuid } from './common.js';

/** ISO date (yyyy-mm-dd) or full ISO timestamp — normalised to yyyy-mm-dd. */
const isoDate = z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
  },
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date'),
);
const optionalIsoDate = isoDate.optional();

/** Non-negative money amount; accepts numeric strings with commas. */
const money = z.preprocess(
  (v) => {
    if (v === '' || v == null) return undefined;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : v;
  },
  z.number().min(0, 'must be ≥ 0').max(1e18),
);

const trimmedText = (max) => z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().max(max),
);
const optionalText = (max) => z.preprocess(
  (v) => (v === '' || v == null ? undefined : (typeof v === 'string' ? v.trim() : v)),
  z.string().max(max).optional(),
);

export const LOSS_TYPES = ['ATTRITIONAL', 'LARGE', 'CAT'];
export const CLAIM_STATUSES = ['OPEN', 'REOPENED', 'CLOSED', 'DECLINED'];
export const MOVEMENT_TYPES = ['ADVICE', 'RESERVE_CHANGE', 'PAYMENT', 'RECOVERY', 'CLOSURE', 'REOPEN'];
export const FINANCE_STATUSES = ['PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'CLOSED'];

// ── POST /api/claims ─────────────────────────────────────────────────────────
export const claimCreateSchema = z.object({
  contract_id: uuid,
  loss_date: isoDate,
  reported_date: optionalIsoDate,
  class_of_business_id: optionalUuid,
  currency_id: optionalUuid,
  cedant_claim_ref: optionalText(120),
  insured_name: optionalText(300),
  cause_of_loss: optionalText(300),
  description: optionalText(4000),
  loss_type: z.enum(LOSS_TYPES).default('ATTRITIONAL'),
  cat_event_ref: optionalText(120),
  // Opening position at 100% — booked as movement #1 (ADVICE).
  gross_paid_100: money.default(0),
  gross_os_100: money.default(0),
  comment: optionalText(1000),
}).strict();

// ── PUT /api/claims/:id ──────────────────────────────────────────────────────
export const claimUpdateSchema = z.object({
  loss_date: optionalIsoDate,
  reported_date: optionalIsoDate,
  class_of_business_id: optionalUuid,
  currency_id: optionalUuid,
  cedant_claim_ref: optionalText(120),
  insured_name: optionalText(300),
  cause_of_loss: optionalText(300),
  description: optionalText(4000),
  loss_type: z.enum(LOSS_TYPES).optional(),
  cat_event_ref: optionalText(120),
}).strict();

// ── POST /api/claims/:id/movements ───────────────────────────────────────────
export const movementCreateSchema = z.object({
  movement_type: z.enum(['ADVICE', 'RESERVE_CHANGE', 'PAYMENT', 'RECOVERY']),
  movement_date: optionalIsoDate,
  gross_paid_100: money,
  gross_os_100: money,
  comment: optionalText(1000),
}).strict();

// ── POST /api/claims/:id/close · /decline · /reopen ─────────────────────────
export const claimCloseSchema = z.object({
  reason: optionalText(1000),
}).strict();

// ── POST /api/claims/:id/notes ───────────────────────────────────────────────
export const claimNoteSchema = z.object({
  note: trimmedText(4000).pipe(z.string().min(1, 'note required')),
}).strict();

// ── POST /api/finance/entries/:id/status ────────────────────────────────────
export const financeStatusSchema = z.object({
  status: z.enum(FINANCE_STATUSES),
  notes: optionalText(2000),
}).strict();
