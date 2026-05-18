import { describe, it, expect } from 'vitest';
import {
  treatyHeaderSchema,
  treatyDetailSchema,
  treatyCommissionsSchema,
  treatyPutBodySchema,
} from './treaty.js';

describe('treatyHeaderSchema', () => {
  it('accepts a valid header including uw_status and signed_line_pct', () => {
    const ok = treatyHeaderSchema.parse({
      uw_year: '2026',
      status: 'SIGNED',
      uw_status: 'SIGNED',
      signed_line_pct: '12.5',
      renewal_date: '2026-06-30',
      primary_class_of_business_id: '00000000-0000-0000-0000-000000000001',
    });
    expect(ok.uw_year).toBe(2026);
    expect(ok.signed_line_pct).toBe(12.5);
    expect(ok.primary_class_of_business_id).toBeTruthy();
  });

  it('rejects an invalid uw_status', () => {
    expect(() => treatyHeaderSchema.parse({ uw_status: 'CHILLING' })).toThrow();
  });

  // Regression: the two Postgres enums on contract — contract_status
  // (11 values) and uw_workflow_status (7) — were conflated in an
  // earlier draft. status='AWAITING_APPROVAL' then 400'd on live saves.
  it('accepts contract_status values that do NOT exist in uw_workflow_status', () => {
    // QUOTED, BOUND, RENEWED, CANCELLED, OFFERED are in contract_status
    // only. AWAITING_APPROVAL is shared across both enums.
    for (const v of ['AWAITING_APPROVAL', 'QUOTED', 'BOUND', 'RENEWED', 'CANCELLED', 'OFFERED']) {
      expect(() => treatyHeaderSchema.parse({ status: v })).not.toThrow();
    }
  });

  it('rejects the legacy WAITING_APPROVAL spelling on both columns', () => {
    // Pre-migration 103 there were two spellings — WAITING_APPROVAL on
    // uw_status, AWAITING_APPROVAL on status. Consolidated to the latter.
    expect(() => treatyHeaderSchema.parse({ status: 'WAITING_APPROVAL' })).toThrow();
    expect(() => treatyHeaderSchema.parse({ uw_status: 'WAITING_APPROVAL' })).toThrow();
  });

  it('accepts experience_source = STRAIGHT (DB CHECK allows it)', () => {
    // Regression: earlier draft rejected STRAIGHT and accepted
    // HISTORICAL/BURN which the DB doesn't know about.
    expect(() => treatyHeaderSchema.parse({ experience_source: 'STRAIGHT' })).not.toThrow();
    expect(() => treatyHeaderSchema.parse({ experience_source: 'TRIANGLE' })).not.toThrow();
    expect(() => treatyHeaderSchema.parse({ experience_source: 'HISTORICAL' })).toThrow();
  });

  it('passes through unknown keys (incremental schema tightening)', () => {
    const r = treatyHeaderSchema.parse({ some_new_field: 'value', uw_year: 2026 });
    expect(r.some_new_field).toBe('value');
  });
});

describe('treatyDetailSchema', () => {
  it('coerces strings to numbers', () => {
    expect(treatyDetailSchema.parse({ qs_limit: '2,500,000' }).qs_limit).toBe(2_500_000);
  });
  it('rejects negative money', () => {
    expect(() => treatyDetailSchema.parse({ qs_limit: -1 })).toThrow();
  });
});

describe('treatyCommissionsSchema', () => {
  it('accepts FIXED mode + percent fields', () => {
    const r = treatyCommissionsSchema.parse({ mode: 'FIXED', fixed_commission_pct: 22.5 });
    expect(r.fixed_commission_pct).toBe(22.5);
  });
  it('accepts SLIDING mode (matches Postgres commission_mode enum)', () => {
    expect(() => treatyCommissionsSchema.parse({ mode: 'SLIDING' })).not.toThrow();
  });
  it('rejects PROFIT mode — it was a phantom; commission_mode has only FIXED and SLIDING', () => {
    expect(() => treatyCommissionsSchema.parse({ mode: 'PROFIT' })).toThrow();
  });

  it('accepts lcf_years (0..20) + lcf_extinction', () => {
    const r = treatyCommissionsSchema.parse({ mode: 'FIXED', lcf_years: 3, lcf_extinction: true });
    expect(r.lcf_years).toBe(3);
    expect(r.lcf_extinction).toBe(true);
  });

  it('accepts lcf_years = 0 (no carry-forward) and null', () => {
    expect(treatyCommissionsSchema.parse({ lcf_years: 0 }).lcf_years).toBe(0);
    expect(treatyCommissionsSchema.parse({ lcf_years: null }).lcf_years).toBeNull();
  });

  it('rejects negative lcf_years and values > 20', () => {
    expect(() => treatyCommissionsSchema.parse({ lcf_years: -1 })).toThrow();
    expect(() => treatyCommissionsSchema.parse({ lcf_years: 25 })).toThrow();
  });

  it('rejects non-integer lcf_years', () => {
    expect(() => treatyCommissionsSchema.parse({ lcf_years: 2.5 })).toThrow();
  });

  it('coerces truthy strings for lcf_extinction (boolish)', () => {
    expect(treatyCommissionsSchema.parse({ lcf_extinction: 'true' }).lcf_extinction).toBe(true);
    expect(treatyCommissionsSchema.parse({ lcf_extinction: 'false' }).lcf_extinction).toBe(false);
  });
});

describe('treatyPutBodySchema', () => {
  it('accepts an empty body', () => {
    expect(treatyPutBodySchema.parse({}).terms).toEqual({});
  });

  it('accepts any short string for save_mode (client-only audit marker)', () => {
    // Was z.enum(['MANUAL','AUTO']) which would have rejected future
    // markers like 'AUTOSAVE' or 'BLUR'. Loosened to string.
    expect(treatyPutBodySchema.parse({ save_mode: 'MANUAL' }).save_mode).toBe('MANUAL');
    expect(treatyPutBodySchema.parse({ save_mode: 'AUTOSAVE' }).save_mode).toBe('AUTOSAVE');
  });

  it('accepts a full-shape partial save', () => {
    const r = treatyPutBodySchema.parse({
      terms: {
        header: { uw_year: 2026, uw_status: 'DRAFT' },
        detail: { cession_pct: '25' },
        commissions: { mode: 'SLIDING', sliding_min_commission: '5', sliding_max_commission: '30' },
        classIds: ['00000000-0000-0000-0000-000000000001'],
      },
      save_mode: 'MANUAL',
    });
    expect(r.terms.header.uw_year).toBe(2026);
    expect(r.terms.detail.cession_pct).toBe(25);
    expect(r.terms.commissions.mode).toBe('SLIDING');
  });
});
