import { describe, it, expect } from 'vitest';
import {
  mbbefdCurve, tabulatedCurve, curveEvaluator,
  layerExpectedLoss, deductibleCredit, exposureCurveLossCost,
} from './exposureCurve.js';

const LINEAR_POINTS = Array.from({ length: 11 }, (_, i) => ({ x: i / 10, y: i / 10 }));

describe('mbbefdCurve — Bernegger (1997) two-parameter exposure curve', () => {
  it('is the identity when g = 1 or b = 0 (no severity information)', () => {
    for (const G of [mbbefdCurve(0, 5), mbbefdCurve(2, 1)]) {
      for (const x of [0, 0.25, 0.5, 0.75, 1]) expect(G(x)).toBeCloseTo(x, 12);
    }
  });

  it('pins G(0) = 0 and G(1) = 1 for every parameter pair', () => {
    for (const [b, g] of [[1, 5], [0.5, 2], [2, 0.5 ** -1], [10, 1.2], [0.1, 50]]) {
      const G = mbbefdCurve(b, g);
      expect(G(0)).toBe(0);
      expect(G(1)).toBe(1);
    }
  });

  it('is monotone increasing and concave for a typical property parameterisation', () => {
    const G = mbbefdCurve(5, 20);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = G(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // Concave: most of the ground-up cost sits in low damage ratios, which
    // is the whole reason exposure rating beats a flat allocation.
    expect(G(0.1)).toBeGreaterThan(0.1);
    expect(G(0.5)).toBeGreaterThan(0.5);
  });

  it('uses the b = 1 branch, and it agrees with the general branch either side', () => {
    const g = 4;
    const at = mbbefdCurve(1, g)(0.3);
    const below = mbbefdCurve(1 - 1e-7, g)(0.3);
    const above = mbbefdCurve(1 + 1e-7, g)(0.3);
    expect(at).toBeCloseTo(below, 5);
    expect(at).toBeCloseTo(above, 5);
    // Closed form for b = 1: ln(1 + (g-1)x) / ln(g).
    expect(at).toBeCloseTo(Math.log(1 + (g - 1) * 0.3) / Math.log(g), 12);
  });

  it('uses the bg = 1 branch, and it agrees with the general branch either side', () => {
    const b = 0.25;
    const g = 1 / b;                       // bg = 1 exactly
    const at = mbbefdCurve(b, g)(0.4);
    expect(at).toBeCloseTo((1 - b ** 0.4) / (1 - b), 12);
    expect(at).toBeCloseTo(mbbefdCurve(b, g * (1 + 1e-9))(0.4), 5);
  });

  it('rejects parameters outside the class', () => {
    expect(() => mbbefdCurve(-1, 2)).toThrow(/b ≥ 0/);
    expect(() => mbbefdCurve(1, 0.5)).toThrow(/g ≥ 1/);
  });

  it('makes a higher g (a likelier total loss) put more weight in the tail', () => {
    // p = 1/g is the total-loss probability, so a larger g means total
    // losses are rarer and proportionally less of the cost sits at the top.
    const low = mbbefdCurve(3, 1.5)(0.5);
    const high = mbbefdCurve(3, 50)(0.5);
    expect(high).toBeGreaterThan(low);
  });
});

describe('tabulatedCurve', () => {
  it('interpolates linearly between points', () => {
    const G = tabulatedCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }]);
    expect(G(0.25)).toBeCloseTo(0.4, 12);
    expect(G(0.75)).toBeCloseTo(0.9, 12);
  });

  it('pins the ends and clamps out-of-range input', () => {
    const G = tabulatedCurve([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.9 }]);
    expect(G(0)).toBe(0);
    expect(G(1)).toBe(1);
    expect(G(-5)).toBe(0);
    expect(G(99)).toBe(1);
  });

  it('sorts unordered points rather than trusting the caller', () => {
    const G = tabulatedCurve([{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.8 }]);
    expect(G(0.25)).toBeCloseTo(0.4, 12);
  });

  it('needs at least two points', () => {
    expect(() => tabulatedCurve([{ x: 0, y: 0 }])).toThrow(/at least two points/);
  });

  it('reads DB rows, whose numerics arrive as strings', () => {
    const G = tabulatedCurve([{ x: '0', y: '0' }, { x: '0.5', y: '0.8' }, { x: '1', y: '1' }]);
    expect(G(0.5)).toBeCloseTo(0.8, 12);
  });
});

describe('curveEvaluator', () => {
  it('builds from tabulated points', () => {
    expect(curveEvaluator({ kind: 'TABULATED', points: LINEAR_POINTS })(0.3)).toBeCloseTo(0.3, 12);
  });
  it('builds from MBBEFD parameters', () => {
    expect(curveEvaluator({ kind: 'MBBEFD', params: { b: 0, g: 1 } })(0.3)).toBeCloseTo(0.3, 12);
  });
  it('refuses to guess when no curve is given', () => {
    expect(() => curveEvaluator(null)).toThrow(/No exposure curve/);
  });
});

describe('layerExpectedLoss', () => {
  const G = tabulatedCurve(LINEAR_POINTS);   // G(x) = x

  it('allocates a layer as the difference of the curve at its two ends', () => {
    // MPL 1,000,000; ground-up expected loss 100,000. Under G(x) = x the
    // layer 200k xs 300k takes (0.5 − 0.3) = 20% of the cost.
    const loss = layerExpectedLoss({
      groundUpLoss: 100_000, mpl: 1_000_000, attachment: 300_000, limit: 200_000, G,
    });
    expect(loss).toBeCloseTo(20_000, 6);
  });

  it('gives the whole ground-up loss to a ground-up unlimited layer', () => {
    expect(layerExpectedLoss({
      groundUpLoss: 100_000, mpl: 1_000_000, attachment: 0, limit: Infinity, G,
    })).toBeCloseTo(100_000, 6);
  });

  it('caps at the MPL — a layer above it is free cover', () => {
    expect(layerExpectedLoss({
      groundUpLoss: 100_000, mpl: 1_000_000, attachment: 1_000_000, limit: 5_000_000, G,
    })).toBe(0);
  });

  it('never returns a negative cost', () => {
    expect(layerExpectedLoss({ groundUpLoss: 100, mpl: 1000, attachment: 500, limit: 0, G })).toBe(0);
    expect(layerExpectedLoss({ groundUpLoss: 0, mpl: 1000, attachment: 0, limit: 100, G })).toBe(0);
    expect(layerExpectedLoss({ groundUpLoss: 100, mpl: 0, attachment: 0, limit: 100, G })).toBe(0);
  });

  it('splits the tower into pieces that sum back to the whole', () => {
    const curve = mbbefdCurve(4, 12);
    const whole = layerExpectedLoss({ groundUpLoss: 500_000, mpl: 2_000_000, attachment: 0, limit: 2_000_000, G: curve });
    const parts = [[0, 500_000], [500_000, 500_000], [1_000_000, 1_000_000]]
      .map(([d, l]) => layerExpectedLoss({ groundUpLoss: 500_000, mpl: 2_000_000, attachment: d, limit: l, G: curve }))
      .reduce((a, b) => a + b, 0);
    expect(parts).toBeCloseTo(whole, 6);
    expect(whole).toBeCloseTo(500_000, 6);
  });
});

describe('deductibleCredit', () => {
  it('is the curve value at the deductible', () => {
    const G = mbbefdCurve(4, 12);
    const credit = deductibleCredit({ mpl: 1_000_000, deductible: 50_000, G });
    expect(credit).toBeCloseTo(G(0.05), 12);
    // A concave curve puts real money in a small deductible — which is the
    // point of pricing it rather than ignoring it.
    expect(credit).toBeGreaterThan(0.05);
  });

  it('is zero without a deductible or an MPL', () => {
    const G = mbbefdCurve(4, 12);
    expect(deductibleCredit({ mpl: 1_000_000, deductible: 0, G })).toBe(0);
    expect(deductibleCredit({ mpl: 0, deductible: 100, G })).toBe(0);
  });
});

describe('exposureCurveLossCost', () => {
  const curve = { kind: 'TABULATED', curve_code: 'LINEAR', points: LINEAR_POINTS };

  it('sums the bands and expresses the result as a rate', () => {
    const out = exposureCurveLossCost({
      bands: [
        { exposure: 10_000_000, pmlPct: 1, groundUpRatePm: 1.0, curve },
        { exposure: 5_000_000, pmlPct: 1, groundUpRatePm: 2.0, curve },
      ],
      attachment: 0, limit: Infinity,
    });
    expect(out.available).toBe(true);
    // 10m × 1‰ + 5m × 2‰ = 10,000 + 10,000
    expect(out.lossCost).toBeCloseTo(20_000, 6);
    expect(out.ratePm).toBeCloseTo((20_000 / 15_000_000) * 1000, 9);
    expect(out.diagnostics.bands).toHaveLength(2);
  });

  it('prices an excess layer below the whole ground-up cost', () => {
    const bands = [{ exposure: 10_000_000, pmlPct: 0.5, groundUpRatePm: 1.0, curve }];
    const ground = exposureCurveLossCost({ bands, attachment: 0, limit: Infinity });
    const excess = exposureCurveLossCost({ bands, attachment: 1_000_000, limit: 4_000_000 });
    expect(excess.lossCost).toBeLessThan(ground.lossCost);
    expect(excess.lossCost).toBeGreaterThan(0);
  });

  it('reports unavailable — not zero — when no curve is configured', () => {
    // A carrier with no curve set has not made an error; the blend has to
    // carry on with the methods it does have.
    const out = exposureCurveLossCost({
      bands: [{ exposure: 1_000_000, pmlPct: 1, groundUpRatePm: 1, curve: null }],
    });
    expect(out.available).toBe(false);
    expect(out.lossCost).toBeUndefined();
    expect(out.unavailableReason).toMatch(/curve set/i);
  });

  it('reports unavailable when there is no exposure at all', () => {
    const out = exposureCurveLossCost({ bands: [] });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/No exposure bands/);
  });
});
