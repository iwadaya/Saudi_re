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
  parseLooseNumber,
  attachmentFromLossRatio,
  erf,
  normalCdf,
  normalPdf,
  normalStopLossPremium,
  normalLayerMean,
  lognormalFromMeanCv,
  lognormalMoments,
  paretoMoments,
  compoundPoissonMoments,
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

describe('parseLooseNumber (canonical client/server parser)', () => {
  it('passes through finite numbers; non-finite → 0', () => {
    expect(parseLooseNumber(0.0425)).toBe(0.0425);
    expect(parseLooseNumber(-3)).toBe(-3);
    expect(parseLooseNumber(NaN)).toBe(0);
    expect(parseLooseNumber(Infinity)).toBe(0);
  });

  it('strips %, currency and thousands separators that Number() would zero', () => {
    expect(parseLooseNumber('8.00%')).toBeCloseTo(8, 10);
    expect(parseLooseNumber('$2,000')).toBeCloseTo(2000, 10);
    expect(parseLooseNumber('1,000')).toBeCloseTo(1000, 10);
    expect(parseLooseNumber('1,250')).toBeCloseTo(1250, 10);
  });

  it('nullish / empty / non-numeric → 0', () => {
    expect(parseLooseNumber(null)).toBe(0);
    expect(parseLooseNumber(undefined)).toBe(0);
    expect(parseLooseNumber('')).toBe(0);
    expect(parseLooseNumber('foo')).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Stop-Loss / Aggregate-XL primitives
// ────────────────────────────────────────────────────────────────────────────

describe('attachmentFromLossRatio', () => {
  it('80% of 10M EPI → 8M attachment', () => {
    expect(attachmentFromLossRatio(80, 10_000_000)).toBe(8_000_000);
  });
  it('0% → 0', () => {
    expect(attachmentFromLossRatio(0, 10_000_000)).toBe(0);
  });
  it('negative LR clamped to 0', () => {
    expect(attachmentFromLossRatio(-20, 10_000_000)).toBe(0);
  });
  it('invalid EPI → 0', () => {
    expect(attachmentFromLossRatio(80, 0)).toBe(0);
    expect(attachmentFromLossRatio(80, -1)).toBe(0);
    expect(attachmentFromLossRatio(80, NaN)).toBe(0);
  });
});

describe('erf / normal CDF + PDF', () => {
  it('erf(0) = 0, erf(∞) ≈ 1', () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(5)).toBeCloseTo(1, 6);
    expect(erf(-5)).toBeCloseTo(-1, 6);
  });
  it('erf is odd: erf(-x) = -erf(x)', () => {
    expect(erf(-1.2)).toBeCloseTo(-erf(1.2), 6);
  });
  it('Φ(0) = 0.5, Φ(±∞) = 0 / 1', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(5)).toBeCloseTo(1, 5);
    expect(normalCdf(-5)).toBeCloseTo(0, 5);
  });
  it('Φ(1) ≈ 0.8413 (textbook value)', () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });
  it('φ(0) = 1/√(2π) ≈ 0.3989', () => {
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 6);
  });
  it('general normal: Φ(μ, μ, σ) = 0.5', () => {
    expect(normalCdf(100, 100, 25)).toBeCloseTo(0.5, 6);
  });
  it('std ≤ 0 → 0 (defensive)', () => {
    expect(normalCdf(1, 0, 0)).toBe(0);
    expect(normalPdf(1, 0, -1)).toBe(0);
  });
});

describe('normalStopLossPremium / normalLayerMean', () => {
  // π(K) = (μ-K)Φ((μ-K)/σ) + σφ((μ-K)/σ). At K = μ: (0)·0.5 + σ·φ(0) = σ/√(2π).
  it('π(μ) = σ/√(2π)', () => {
    expect(normalStopLossPremium(100, 20, 100)).toBeCloseTo(20 / Math.sqrt(2 * Math.PI), 6);
  });
  it('π(K) → max(0, μ-K) as K moves far from μ', () => {
    // Far below mean → π ≈ μ-K (whole distribution above attachment)
    expect(normalStopLossPremium(100, 5, 50)).toBeCloseTo(50, 3);
    // Far above mean → π ≈ 0 (no chance of breaching)
    expect(normalStopLossPremium(100, 5, 200)).toBeCloseTo(0, 6);
  });
  it('zero-σ collapses to deterministic stop-loss = max(0, μ-K)', () => {
    expect(normalStopLossPremium(100, 0, 80)).toBe(20);
    expect(normalStopLossPremium(100, 0, 120)).toBe(0);
  });
  it('layer mean = π(D) − π(D+L); positive and ≤ L', () => {
    const out = normalLayerMean(100, 30, 80, 40);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(40);
    expect(out).toBeCloseTo(
      normalStopLossPremium(100, 30, 80) - normalStopLossPremium(100, 30, 120),
      10,
    );
  });
  it('layer width ≤ 0 → 0', () => {
    expect(normalLayerMean(100, 30, 80, 0)).toBe(0);
    expect(normalLayerMean(100, 30, 80, -10)).toBe(0);
  });
});

describe('lognormalFromMeanCv / lognormalMoments round-trip', () => {
  it('mean = 1M, CV = 0.5 → moments round-trip to the input mean', () => {
    const { mu, sigma } = lognormalFromMeanCv(1_000_000, 0.5);
    const moments = lognormalMoments(mu, sigma);
    expect(moments.mean).toBeCloseTo(1_000_000, 4);
    // Var/E² = CV²  →  Var = 0.25·1e12 = 2.5e11
    expect(moments.variance).toBeCloseTo(0.25 * 1e12, -3);
  });
  it('zero CV → degenerate (σ=0, mean = exp(μ))', () => {
    const { mu, sigma } = lognormalFromMeanCv(500_000, 0);
    expect(sigma).toBe(0);
    expect(Math.exp(mu)).toBeCloseTo(500_000, 4);
  });
  it('invalid inputs → null', () => {
    expect(lognormalFromMeanCv(0, 0.5)).toBe(null);
    expect(lognormalFromMeanCv(-1, 0.5)).toBe(null);
    expect(lognormalFromMeanCv(100, -0.1)).toBe(null);
  });
});

describe('paretoMoments', () => {
  // α=3, θ=100k → E[X] = 3·100k/2 = 150k; E[X²] = 3·1e10/1 = 3e10
  it('finite moments for α > 2', () => {
    const m = paretoMoments(3, 100_000);
    expect(m.mean).toBeCloseTo(150_000, 4);
    expect(m.secondMoment).toBeCloseTo(3e10, -3);
    expect(m.variance).toBeCloseTo(m.secondMoment - m.mean ** 2, -3);
  });
  it('α ∈ (1, 2] → finite mean, infinite second moment', () => {
    const m = paretoMoments(1.5, 100_000);
    expect(Number.isFinite(m.mean)).toBe(true);
    expect(m.secondMoment).toBe(Infinity);
    expect(m.variance).toBe(Infinity);
  });
  it('α ≤ 1 → both moments infinite', () => {
    const m = paretoMoments(0.8, 100_000);
    expect(m.mean).toBe(Infinity);
    expect(m.secondMoment).toBe(Infinity);
  });
  it('invalid inputs → zeros', () => {
    expect(paretoMoments(0, 100_000).mean).toBe(0);
    expect(paretoMoments(2, 0).mean).toBe(0);
    expect(paretoMoments(NaN, 100_000).mean).toBe(0);
  });
});

describe('compoundPoissonMoments', () => {
  it('E[S] = λ·E[X], Var[S] = λ·E[X²] — NOT λ·Var[X]', () => {
    // λ=10, E[X]=100k, E[X²]=2e10 → E[S]=1M, Var[S]=2e11
    const m = compoundPoissonMoments(10, 100_000, 2e10);
    expect(m.mean).toBeCloseTo(1_000_000, 4);
    expect(m.variance).toBeCloseTo(2e11, -3);
    expect(m.std).toBeCloseTo(Math.sqrt(2e11), -3);
  });
  it('λ=0 → degenerate aggregate (mean 0, var 0)', () => {
    const m = compoundPoissonMoments(0, 100_000, 2e10);
    expect(m.mean).toBe(0);
    expect(m.variance).toBe(0);
    expect(m.std).toBe(0);
  });
  it('infinite severity second moment → infinite aggregate variance, finite mean', () => {
    const m = compoundPoissonMoments(5, 150_000, Infinity);
    expect(m.mean).toBeCloseTo(750_000, 4);
    expect(m.variance).toBe(Infinity);
  });
  it('invalid λ → zeros', () => {
    expect(compoundPoissonMoments(-1, 100, 1e6).mean).toBe(0);
    expect(compoundPoissonMoments(NaN, 100, 1e6).mean).toBe(0);
  });
});

describe('end-to-end: compound Poisson stop-loss premium', () => {
  // Sanity check: a Poisson(10) of Lognormal(mean=100k, CV=0.5) severities.
  // E[S] = 1M, Var[S] = λ·E[X²] = 10·100k²·(1+0.25) = 1.25e11; SD ≈ 353,553.
  // Stop loss at retention = E[S] (50/50 chance of breaching).
  // Normal approx: π(μ) = σ/√(2π) ≈ 141,047.
  it('matches the textbook σ/√(2π) value when D = E[S]', () => {
    const { mu, sigma } = lognormalFromMeanCv(100_000, 0.5);
    const sev = lognormalMoments(mu, sigma);
    const agg = compoundPoissonMoments(10, sev.mean, sev.secondMoment);
    expect(agg.mean).toBeCloseTo(1_000_000, 4);
    expect(agg.std).toBeCloseTo(Math.sqrt(1.25e11), -3);
    const layer = normalLayerMean(agg.mean, agg.std, agg.mean, 10_000_000);
    expect(layer).toBeCloseTo(agg.std / Math.sqrt(2 * Math.PI), -1);
  });
});
