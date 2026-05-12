// Tests for shared/pricingMath.js. Same formulas are used on both
// tiers (client for live-calc, server for validation) — these tests
// lock them down.

import { describe, it, expect } from 'vitest';
import {
  layerHit,
  weightedAverage,
  annualiseLoss,
  rolFromAnnualLoss,
  premiumFromRol,
  clamp,
  applyLoading,
  deriveComponentTotal,
} from './pricingMath.js';

describe('layerHit', () => {
  it('loss below deductible → 0', () => {
    expect(layerHit(50_000, 100_000, 500_000)).toBe(0);
  });
  it('loss inside layer → loss - D', () => {
    expect(layerHit(400_000, 100_000, 500_000)).toBe(300_000);
  });
  it('loss above layer top → capped at limit', () => {
    expect(layerHit(10_000_000, 100_000, 500_000)).toBe(500_000);
  });
  it('zero or negative limit → 0', () => {
    expect(layerHit(1_000_000, 100_000, 0)).toBe(0);
    expect(layerHit(1_000_000, 100_000, -500)).toBe(0);
  });
  it('NaN inputs → 0', () => {
    expect(layerHit(NaN, 100, 500)).toBe(0);
    expect(layerHit(200, NaN, 500)).toBe(0);
    expect(layerHit(200, 100, NaN)).toBe(0);
  });
});

describe('weightedAverage', () => {
  it('returns null for empty / mismatched / all-zero weights', () => {
    expect(weightedAverage([], [])).toBe(null);
    expect(weightedAverage([1, 2], [1])).toBe(null);
    expect(weightedAverage([1, 2], [0, 0])).toBe(null);
  });
  it('standard weighted mean', () => {
    expect(weightedAverage([10, 20, 30], [1, 2, 3])).toBeCloseTo((10 + 40 + 90) / 6, 10);
  });
  it('skips non-finite values + non-positive weights', () => {
    expect(weightedAverage([10, NaN, 30], [1, 1, 1])).toBe(20);
    expect(weightedAverage([10, 20, 30], [1, -1, 1])).toBe(20);
  });
});

describe('annualiseLoss', () => {
  it('divides by years', () => {
    expect(annualiseLoss(1_000_000, 5)).toBe(200_000);
  });
  it('returns 0 for invalid years', () => {
    expect(annualiseLoss(1_000_000, 0)).toBe(0);
    expect(annualiseLoss(1_000_000, -1)).toBe(0);
    expect(annualiseLoss(1_000_000, NaN)).toBe(0);
  });
});

describe('rolFromAnnualLoss / premiumFromRol inverse relationship', () => {
  it('round-trips through rol → premium', () => {
    const annualLoss = 450_000;
    const limit = 10_000_000;
    const rol = rolFromAnnualLoss(annualLoss, limit);
    expect(rol).toBeCloseTo(0.045, 10);
    expect(premiumFromRol(rol, limit)).toBeCloseTo(annualLoss, 6);
  });

  it('rol guards against zero limit', () => {
    expect(rolFromAnnualLoss(100, 0)).toBe(0);
    expect(rolFromAnnualLoss(100, -1)).toBe(0);
  });
});

describe('clamp', () => {
  it('clamps in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(100, 0, 10)).toBe(10);
  });
  it('preserves NaN', () => {
    expect(Number.isNaN(clamp(NaN, 0, 10))).toBe(true);
  });
});

describe('applyLoading', () => {
  it('loads the rate — 20% turns 4% into 5%', () => {
    expect(applyLoading(0.04, 20)).toBeCloseTo(0.05, 10);
  });
  it('0 loading is identity', () => {
    expect(applyLoading(0.037, 0)).toBeCloseTo(0.037, 10);
  });
  it('clamps negative loading to 0', () => {
    expect(applyLoading(0.1, -5)).toBe(0.1);
  });
  it('throws on loading >= 100% (was silently returning 0 before)', () => {
    // 100% loading implies division by zero in the gross-up formula, and
    // anything above is negative — neither makes sense as a pricing input.
    expect(() => applyLoading(0.01, 100)).toThrow(RangeError);
    expect(() => applyLoading(0.01, 150)).toThrow(/Loading must be < 100/);
    expect(() => applyLoading(0.01, 100.0001)).toThrow(RangeError);
  });
  it('still allows a 99% loading (huge but finite)', () => {
    // 0.01 / (1 - 0.99) = 1.0
    expect(applyLoading(0.01, 99)).toBeCloseTo(1.0, 10);
  });
  it('NaN rate → 0 (no throw)', () => {
    expect(applyLoading(NaN, 10)).toBe(0);
  });
  it('NaN loading → treated as 0 (no throw)', () => {
    expect(applyLoading(0.05, NaN)).toBeCloseTo(0.05, 10);
  });
});

describe('deriveComponentTotal (3-way blend)', () => {
  // 3-way blend: each component (burn / pareto / exposure) has its own
  // weight; the formula divides by Σ weights so weights need not sum
  // to 100. (b, p, e, wB, wP, wE, loading) → loaded blended rate.

  it('weights summing to 100 — hand-computed reference', () => {
    // (40·0.03 + 20·0.01 + 40·0.05) / 100 = (1.2 + 0.2 + 2.0)/100 = 0.034
    // loaded = 0.034 / (1 - 0.20) = 0.0425
    expect(deriveComponentTotal(0.03, 0.01, 0.05, 40, 20, 40, 20)).toBeCloseTo(0.0425, 10);
  });

  it('weights need not sum to 100 — divides by Σ', () => {
    // (50·0.04 + 0·0.02 + 50·0.06) / 100 = 0.05
    expect(deriveComponentTotal(0.04, 0.02, 0.06, 50, 0, 50, 0)).toBeCloseTo(0.05, 10);
    // Same ratio, larger weights → same answer
    expect(deriveComponentTotal(0.04, 0.02, 0.06, 80, 0, 80, 0)).toBeCloseTo(0.05, 10);
  });

  it('all-zero weights → 0 (no method selected)', () => {
    expect(deriveComponentTotal(0.03, 0.01, 0.05, 0, 0, 0, 20)).toBe(0);
  });

  it('only burn weight non-zero → pure burn through loading', () => {
    // 0.03 / (1 - 0.20) = 0.0375
    expect(deriveComponentTotal(0.03, 0.01, 0.05, 100, 0, 0, 20)).toBeCloseTo(0.0375, 10);
  });

  it('only pareto weight non-zero → pure Pareto through loading', () => {
    // 0.01 / (1 - 0.20) = 0.0125
    expect(deriveComponentTotal(0.03, 0.01, 0.05, 0, 100, 0, 20)).toBeCloseTo(0.0125, 10);
  });

  it('only exposure weight non-zero → pure exposure through loading', () => {
    // 0.05 / (1 - 0.20) = 0.0625
    expect(deriveComponentTotal(0.03, 0.01, 0.05, 0, 0, 100, 20)).toBeCloseTo(0.0625, 10);
  });

  it('0% loading → blended rate unchanged', () => {
    // (50·0.03 + 30·0.01 + 20·0.05) / 100 = (1.5 + 0.3 + 1.0)/100 = 0.028
    expect(deriveComponentTotal(0.03, 0.01, 0.05, 50, 30, 20, 0)).toBeCloseTo(0.028, 10);
  });

  it('99% loading → finite (caps at 99%)', () => {
    const out = deriveComponentTotal(0.03, 0.01, 0.05, 50, 30, 20, 99);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeCloseTo(0.028 / 0.01, 6);
  });

  it('weights clamped to [0,100] — negative weights floored to 0', () => {
    // wB clamped to 0; (0·0.03 + 50·0.01 + 50·0.05)/100 = 0.03 → /0.80 = 0.0375
    expect(deriveComponentTotal(0.03, 0.01, 0.05, -20, 50, 50, 20)).toBeCloseTo(0.0375, 10);
  });

  it('NaN / string inputs treated as zero', () => {
    expect(deriveComponentTotal(NaN, 'foo', undefined, null, '', 'bar', 'x')).toBe(0);
  });

  it('parses %-formatted string inputs as the real client passes them', () => {
    // The client stores rates as "%"-formatted strings; without stripping
    // the % the function used to return 0 (Number("10%") === NaN).
    // Same scenario as the integer test: 40·10 + 20·2 + 40·5 / 100 = 6.4
    // loaded = 6.4 / (1 - 0.20) = 8.0
    expect(deriveComponentTotal('10.00%', '2.00%', '5.00%', '40', '20', '40', '20')).toBeCloseTo(8.0, 6);
  });
});
