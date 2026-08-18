import { describe, it, expect } from 'vitest';
import { benchmarkLossCost, benchmarkPosition, percentile, MIN_CONFIDENT_OBSERVATIONS } from './benchmark.js';

const obs = (...rates) => rates.map((rate_pm, i) => ({ rate_pm, uw_year: 2020 + i }));

describe('percentile', () => {
  it('interpolates between neighbours', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12);
    expect(percentile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
  });
  it('handles degenerate samples', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.5)).toBe(7);
  });
});

describe('benchmarkLossCost', () => {
  it('is the median of the bound comparables, with quartiles', () => {
    const out = benchmarkLossCost({ observations: obs(1, 2, 3, 4, 5), scope: 'GCC · IAR' });
    expect(out.available).toBe(true);
    expect(out.ratePm).toBeCloseTo(3, 12);
    expect(out.diagnostics.p25).toBeCloseTo(2, 12);
    expect(out.diagnostics.p75).toBeCloseTo(4, 12);
    expect(out.diagnostics.n).toBe(5);
    expect(out.diagnostics.scope).toBe('GCC · IAR');
  });

  it('grades its own confidence by sample size', () => {
    expect(benchmarkLossCost({ observations: obs(1, 2) }).diagnostics.confidence).toBe('LOW');
    expect(benchmarkLossCost({ observations: obs(1, 2, 3, 4, 5) }).diagnostics.confidence).toBe('MEDIUM');
    expect(benchmarkLossCost({
      observations: Array.from({ length: 25 }, (_, i) => ({ rate_pm: i + 1 })),
    }).diagnostics.confidence).toBe('HIGH');
  });

  it('says out loud when the median rests on a handful of risks', () => {
    const out = benchmarkLossCost({ observations: obs(1.2, 1.4) });
    expect(out.available).toBe(true);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/only 2 bound risks/);
    expect(MIN_CONFIDENT_OBSERVATIONS).toBe(5);
  });

  it('is unavailable, with a reason, before anything has been bound', () => {
    const out = benchmarkLossCost({ observations: [] });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/builds itself as business is bound/);
  });

  it('ignores nil and unparseable rates rather than counting them as zero', () => {
    const out = benchmarkLossCost({
      observations: [{ rate_pm: 2 }, { rate_pm: null }, { rate_pm: 0 }, { rate_pm: 'x' }, { rate_pm: 4 }],
    });
    expect(out.diagnostics.n).toBe(2);
    expect(out.ratePm).toBeCloseTo(3, 12);
  });

  it('reports the underwriting years the sample spans', () => {
    const out = benchmarkLossCost({ observations: obs(1, 2, 3) });
    expect(out.diagnostics.uw_years).toEqual([2020, 2022]);
  });
});

describe('benchmarkPosition', () => {
  const { diagnostics } = benchmarkLossCost({ observations: obs(1, 2, 3, 4, 5) });

  it('places a rate against the distribution', () => {
    expect(benchmarkPosition(1.5, diagnostics).position).toBe('BELOW_P25');
    expect(benchmarkPosition(2.5, diagnostics).position).toBe('P25_P50');
    expect(benchmarkPosition(3.5, diagnostics).position).toBe('P50_P75');
    expect(benchmarkPosition(9, diagnostics).position).toBe('ABOVE_P75');
  });

  it('reports the ratio to the median', () => {
    expect(benchmarkPosition(6, diagnostics).ratio).toBeCloseTo(2, 12);
  });

  it('is null without a rate or without a sample', () => {
    expect(benchmarkPosition(null, diagnostics)).toBeNull();
    expect(benchmarkPosition(1, { n: 0 })).toBeNull();
  });
});
