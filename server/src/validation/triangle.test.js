import { describe, it, expect } from 'vitest';
import { triangleCellsSchema, devFactorPutSchema, triangleTypeSchema } from './triangle.js';

describe('triangleTypeSchema', () => {
  it('accepts the documented enum values', () => {
    for (const t of ['PREMIUM', 'CLAIMS_PAID', 'CLAIMS_OS', 'INCURRED', 'NP_EXCESS']) {
      expect(triangleTypeSchema.parse(t)).toBe(t);
    }
  });

  it('rejects unknown types', () => {
    expect(() => triangleTypeSchema.parse('UNKNOWN')).toThrow();
    expect(() => triangleTypeSchema.parse('paid')).toThrow();
  });
});

describe('triangleCellsSchema', () => {
  it('accepts a normalised cell array', () => {
    const parsed = triangleCellsSchema.parse([
      { origin_year: 2020, dev_months: 12, cum_value: 1000 },
      { origin_year: 2020, dev_months: 24, cum_value: 1500 },
      { origin_year: 2021, dev_months: 12, cum_value: null },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[2].cum_value).toBeNull();
  });

  it('coerces stringified numerics', () => {
    const parsed = triangleCellsSchema.parse([
      { origin_year: '2020', dev_months: '12', cum_value: '1000.50' },
    ]);
    expect(parsed[0].origin_year).toBe(2020);
    expect(parsed[0].dev_months).toBe(12);
    expect(parsed[0].cum_value).toBe(1000.5);
  });

  it('accepts negative cum_value (claims net of recoveries)', () => {
    const parsed = triangleCellsSchema.parse([
      { origin_year: 2020, dev_months: 12, cum_value: -500 },
    ]);
    expect(parsed[0].cum_value).toBe(-500);
  });

  it('rejects out-of-range origin_year', () => {
    expect(() => triangleCellsSchema.parse([
      { origin_year: 1800, dev_months: 12, cum_value: 0 },
    ])).toThrow();
    expect(() => triangleCellsSchema.parse([
      { origin_year: 2200, dev_months: 12, cum_value: 0 },
    ])).toThrow();
  });

  it('rejects negative dev_months', () => {
    expect(() => triangleCellsSchema.parse([
      { origin_year: 2020, dev_months: -12, cum_value: 0 },
    ])).toThrow();
  });

  it('rejects dev_months above the 60-year ceiling', () => {
    expect(() => triangleCellsSchema.parse([
      { origin_year: 2020, dev_months: 1000, cum_value: 0 },
    ])).toThrow();
  });

  it('rejects non-finite cum_value', () => {
    expect(() => triangleCellsSchema.parse([
      { origin_year: 2020, dev_months: 12, cum_value: 'not-a-number' },
    ])).toThrow();
  });

  it('accepts an empty array', () => {
    expect(triangleCellsSchema.parse([])).toEqual([]);
  });
});

describe('devFactorPutSchema', () => {
  it('accepts a typical UI payload', () => {
    const parsed = devFactorPutSchema.parse({
      factors: [
        { dev_month: 12, selected_ldf: 1.5, chosen_ldf: 1.5, chosen_source: 'SELECTED' },
        { dev_month: 24, selected_ldf: 1.2, chosen_ldf: 1.2, chosen_source: 'SELECTED', overridden: false },
      ],
      method: 'WEIGHTED',
      _actor: 'tester',
    });
    expect(parsed.factors).toHaveLength(2);
    expect(parsed.factors[0].dev_month).toBe(12);
  });

  it('accepts link-ratio chosen factors from the exclusion table', () => {
    const parsed = devFactorPutSchema.parse({
      factors: [
        { dev_month: 12, chosen_ldf: 1.2, chosen_cdf: 1.44, chosen_source: 'LINK_RATIO' },
      ],
      method: 'WEIGHTED',
    });
    expect(parsed.factors[0].chosen_source).toBe('LINK_RATIO');
  });

  it('coerces empty-string LDFs to null', () => {
    const parsed = devFactorPutSchema.parse({
      factors: [
        { dev_month: 12, selected_ldf: '', actual_ldf: null, param_ldf: '1.05' },
      ],
    });
    expect(parsed.factors[0].selected_ldf).toBeNull();
    expect(parsed.factors[0].actual_ldf).toBeNull();
    expect(parsed.factors[0].param_ldf).toBeCloseTo(1.05);
  });

  it('rejects an LDF outside the [0, 50] window', () => {
    expect(() => devFactorPutSchema.parse({
      factors: [{ dev_month: 12, selected_ldf: 100 }],
    })).toThrow();
    expect(() => devFactorPutSchema.parse({
      factors: [{ dev_month: 12, selected_ldf: -1 }],
    })).toThrow();
  });

  it('rejects a missing dev_month', () => {
    expect(() => devFactorPutSchema.parse({
      factors: [{ selected_ldf: 1.5 }],
    })).toThrow();
  });

  it('defaults factors to empty when omitted', () => {
    const parsed = devFactorPutSchema.parse({});
    expect(parsed.factors).toEqual([]);
  });

  it('rejects an unknown chosen_source', () => {
    expect(() => devFactorPutSchema.parse({
      factors: [{ dev_month: 12, chosen_source: 'INVENTED' }],
    })).toThrow();
  });
});
