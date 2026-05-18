import { describe, it, expect } from 'vitest';
import {
  quoteHeaderSchema,
  quoteDetailSchema,
  quoteCommissionsSchema,
  quoteLossParticipationSchema,
  quotePutBodySchema,
} from './quote.js';

describe('quoteHeaderSchema', () => {
  it('accepts a complete valid header', () => {
    const ok = quoteHeaderSchema.parse({
      cedant_id: '00000000-0000-0000-0000-000000000001',
      uw_year: 2026,
      status: 'DRAFT',
      experience_source: 'TRIANGLE',
      renewal_date: '2026-06-30',
      inception_date: '2026-07-01',
      contract_description: 'Renewal of book',
    });
    expect(ok.uw_year).toBe(2026);
    expect(ok.renewal_date).toBe('2026-06-30');
  });

  it('coerces strings into uw_year ints', () => {
    expect(quoteHeaderSchema.parse({ uw_year: '2026' }).uw_year).toBe(2026);
  });

  it('rejects malformed UUIDs', () => {
    expect(() => quoteHeaderSchema.parse({ cedant_id: 'not-a-uuid' })).toThrow();
  });

  it('treats empty strings as undefined for optional UUIDs', () => {
    const r = quoteHeaderSchema.parse({ cedant_id: '' });
    expect(r.cedant_id).toBeUndefined();
  });

  it('rejects unknown statuses', () => {
    expect(() => quoteHeaderSchema.parse({ status: 'CHILLING' })).toThrow();
  });

  it('passthrough mode keeps unknown keys untouched', () => {
    // Unknown keys pass through so we don't break callers as the
    // schema is tightened incrementally. Tighten with .strict() when
    // we're confident every field is enumerated.
    const r = quoteHeaderSchema.parse({ foo: 'bar', uw_year: 2026 });
    expect(r.foo).toBe('bar');
    expect(r.uw_year).toBe(2026);
  });

  it('parses YYYY-MM-DD dates as-is', () => {
    expect(quoteHeaderSchema.parse({ inception_date: '2026-04-22' }).inception_date).toBe('2026-04-22');
  });

  it('extracts the date from a longer ISO timestamp', () => {
    expect(quoteHeaderSchema.parse({ inception_date: '2026-04-22T13:00:00Z' }).inception_date).toBe('2026-04-22');
  });
});

describe('quoteDetailSchema', () => {
  it('accepts mixed numeric strings and numbers', () => {
    const r = quoteDetailSchema.parse({
      qs_limit: '5,000,000',
      retention_pct: '12.5',
      num_lines: '8',
      total_capacity: 25_000_000,
    });
    expect(r.qs_limit).toBe(5_000_000);
    expect(r.retention_pct).toBe(12.5);
    expect(r.num_lines).toBe(8);
    expect(r.total_capacity).toBe(25_000_000);
  });

  it('rejects negative money', () => {
    expect(() => quoteDetailSchema.parse({ qs_limit: -1 })).toThrow();
  });

  it('rejects pct above 100', () => {
    expect(() => quoteDetailSchema.parse({ retention_pct: 150 })).toThrow();
  });
});

describe('quoteCommissionsSchema', () => {
  it('accepts a minimal commission patch', () => {
    expect(quoteCommissionsSchema.parse({ mode: 'FIXED', fixed_commission_pct: 25 })).toEqual({
      mode: 'FIXED', fixed_commission_pct: 25,
    });
  });

  it('rejects unknown mode', () => {
    expect(() => quoteCommissionsSchema.parse({ mode: 'BANANA' })).toThrow();
  });

  it('accepts lcf_years + lcf_extinction (mirrors treaty schema)', () => {
    const r = quoteCommissionsSchema.parse({ mode: 'FIXED', lcf_years: 5, lcf_extinction: true });
    expect(r.lcf_years).toBe(5);
    expect(r.lcf_extinction).toBe(true);
  });

  it('rejects out-of-range lcf_years', () => {
    expect(() => quoteCommissionsSchema.parse({ lcf_years: -1 })).toThrow();
    expect(() => quoteCommissionsSchema.parse({ lcf_years: 25 })).toThrow();
  });
});

describe('quoteLossParticipationSchema', () => {
  it('accepts boolean and string forms of `enabled`', () => {
    expect(quoteLossParticipationSchema.parse({ enabled: true }).enabled).toBe(true);
    expect(quoteLossParticipationSchema.parse({ enabled: 'false' }).enabled).toBe(false);
  });

  it('accepts an empty slides array', () => {
    expect(() => quoteLossParticipationSchema.parse({ slides: [] })).not.toThrow();
  });

  it('accepts a valid corridor (max_lr > min_lr, all within 0..100)', () => {
    expect(() => quoteLossParticipationSchema.parse({
      slides: [{ min_lr: 70, max_lr: 100, share: 50 }],
    })).not.toThrow();
  });

  it('rejects an inverted corridor', () => {
    expect(() => quoteLossParticipationSchema.parse({
      slides: [{ min_lr: 100, max_lr: 70, share: 50 }],
    })).toThrow(/greater than/);
  });

  it('rejects pct values above 100', () => {
    expect(() => quoteLossParticipationSchema.parse({
      slides: [{ min_lr: 120, max_lr: 150, share: 50 }],
    })).toThrow();
  });

  it('rejects more than 5 slides', () => {
    expect(() => quoteLossParticipationSchema.parse({
      slides: Array.from({ length: 6 }, (_, i) => ({
        min_lr: i * 10,
        max_lr: i * 10 + 5,
        share: 50,
      })),
    })).toThrow();
  });
});

describe('quotePutBodySchema', () => {
  it('accepts an empty body (default partial)', () => {
    const r = quotePutBodySchema.parse({});
    expect(r.terms).toEqual({});
  });

  it('accepts a real-shape patch', () => {
    const r = quotePutBodySchema.parse({
      terms: {
        header: { uw_year: 2026 },
        detail: { qs_limit: '1,000,000' },
        commissions: { mode: 'FIXED', fixed_commission_pct: 22.5 },
      },
    });
    expect(r.terms.header.uw_year).toBe(2026);
    expect(r.terms.detail.qs_limit).toBe(1_000_000);
    expect(r.terms.commissions.fixed_commission_pct).toBe(22.5);
  });

  it('passes through JSONB blobs without prying into their shape', () => {
    const np = { layers: [{ a: 1 }], leadSetup: 'stuff' };
    const r = quotePutBodySchema.parse({ terms: { np_final_pricing: np } });
    expect(r.terms.np_final_pricing).toEqual(np);
  });
});
