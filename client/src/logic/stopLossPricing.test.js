// Tests for the Stop Loss / Aggregate XL pricing engine. Three method
// functions plus the priceStopLoss orchestrator; one Monte Carlo
// convergence test ties everything together end-to-end.

import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  burningCostStopLoss,
  exposureRatingStopLoss,
  monteCarloStopLoss,
  priceStopLoss,
} from './stopLossPricing.js';

// ────────────────────────────────────────────────────────────────────────────
// PRNG sanity — deterministic, in [0,1), covers the unit interval.
// ────────────────────────────────────────────────────────────────────────────

describe('mulberry32 PRNG', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it('returns samples in [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('produces an approximately uniform mean over many draws', () => {
    const r = mulberry32(1);
    let s = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) s += r();
    expect(s / N).toBeCloseTo(0.5, 2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Burning Cost on aggregate annual losses.
// ────────────────────────────────────────────────────────────────────────────

describe('burningCostStopLoss', () => {
  it('hand-computed reference: 5-year window, layer 5M xs 10M', () => {
    // Yearly aggregates and their layer hits (D=10M, L=5M):
    //   2019: 7M     →  0
    //   2020: 11M    →  1M
    //   2021: 18M    →  5M (capped)
    //   2022: 4M     →  0
    //   2023: 12.5M  →  2.5M
    //   Total in layer = 8.5M; annualised over 5 years = 1.7M
    const result = burningCostStopLoss({
      yearlyAggregates: [
        { year: 2019, aggregate: 7_000_000 },
        { year: 2020, aggregate: 11_000_000 },
        { year: 2021, aggregate: 18_000_000 },
        { year: 2022, aggregate: 4_000_000 },
        { year: 2023, aggregate: 12_500_000 },
      ],
      attachment: 10_000_000,
      limit: 5_000_000,
    });
    expect(result.annualLoss).toBeCloseTo(1_700_000, 4);
    expect(result.rol).toBeCloseTo(0.34, 6);
    expect(result.nYears).toBe(5);
    expect(result.byYear[2].inLayer).toBe(5_000_000);
    expect(result.byYear[0].inLayer).toBe(0);
  });

  it('zero-loss years count toward the denominator (long-run frequency)', () => {
    // Same single 5M hit, but spread across windows of different
    // length — annual expected loss must scale 1/N.
    const oneIn3 = burningCostStopLoss({
      yearlyAggregates: [
        { year: 2021, aggregate: 0 },
        { year: 2022, aggregate: 15_000_000 },
        { year: 2023, aggregate: 0 },
      ],
      attachment: 10_000_000,
      limit: 5_000_000,
    });
    const oneIn10 = burningCostStopLoss({
      yearlyAggregates: [
        ...Array.from({ length: 9 }, (_, i) => ({ year: 2014 + i, aggregate: 0 })),
        { year: 2023, aggregate: 15_000_000 },
      ],
      attachment: 10_000_000,
      limit: 5_000_000,
    });
    expect(oneIn3.annualLoss).toBeCloseTo(5_000_000 / 3, 4);
    expect(oneIn10.annualLoss).toBeCloseTo(5_000_000 / 10, 4);
  });

  it('empty / invalid input → zero annual loss', () => {
    const r = burningCostStopLoss({ yearlyAggregates: [], attachment: 1, limit: 1 });
    expect(r.annualLoss).toBe(0);
    expect(r.nYears).toBe(0);
  });

  it('skips NaN aggregates by treating them as zero (no crash)', () => {
    const r = burningCostStopLoss({
      yearlyAggregates: [
        { year: 2022, aggregate: NaN },
        { year: 2023, aggregate: 12_000_000 },
      ],
      attachment: 10_000_000,
      limit: 5_000_000,
    });
    expect(r.byYear[0].inLayer).toBe(0);
    expect(r.byYear[1].inLayer).toBe(2_000_000);
    expect(r.annualLoss).toBeCloseTo(1_000_000, 4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Exposure Rating — analytical, via Normal approximation.
// ────────────────────────────────────────────────────────────────────────────

describe('exposureRatingStopLoss (Normal approximation)', () => {
  it('Lognormal severity: aggregate moments match closed form', () => {
    // λ=20, severity mean=200k, CV=0.6 → E[S]=4M; Var[X] = (0.6·200k)² = 1.44e10
    // E[X²] = mean²(1 + CV²) = 4e10·1.36 = 5.44e10
    // Var[S] = λ·E[X²] = 20·5.44e10 = 1.088e12; SD ≈ 1,043,072
    const out = exposureRatingStopLoss({
      frequency: { lambda: 20 },
      severity: { type: 'lognormal', mean: 200_000, cv: 0.6 },
      attachment: 4_000_000,
      limit: 3_000_000,
    });
    expect(out.aggMean).toBeCloseTo(4_000_000, 4);
    expect(out.aggStd).toBeCloseTo(Math.sqrt(1.088e12), -3);
    // At D = E[S], the stop-loss premium π(D) = σ/√(2π). The layer
    // is π(D) − π(D+L); for L ≈ 3σ the upper tail subtracts ~0.15%,
    // so annualLoss should be just below σ/√(2π).
    const upper = out.aggStd / Math.sqrt(2 * Math.PI);
    expect(out.annualLoss).toBeLessThan(upper);
    expect(Math.abs(out.annualLoss - upper) / upper).toBeLessThan(0.01);
    expect(out.normalApproxValid).toBe(true);
  });

  it('Pareto with α ≤ 2 → Normal approximation flagged invalid', () => {
    const warnings = [];
    const out = exposureRatingStopLoss({
      frequency: { lambda: 5 },
      severity: { type: 'pareto', alpha: 1.8, theta: 100_000 },
      attachment: 5_000_000,
      limit: 1_000_000,
      warnings,
    });
    expect(out.normalApproxValid).toBe(false);
    expect(out.annualLoss).toBe(0);
    expect(warnings.join(' ')).toMatch(/Normal approximation invalid/i);
  });

  it('λ = 0 → mean is 0 → layer cost is 0', () => {
    const out = exposureRatingStopLoss({
      frequency: { lambda: 0 },
      severity: { type: 'lognormal', mean: 100_000, cv: 0.5 },
      attachment: 1_000_000,
      limit: 500_000,
    });
    expect(out.aggMean).toBe(0);
    expect(out.annualLoss).toBe(0);
  });

  it('invalid severity returns null with a warning', () => {
    const warnings = [];
    const out = exposureRatingStopLoss({
      frequency: { lambda: 5 },
      severity: { type: 'lognormal', mean: -100, cv: 0.5 },
      attachment: 1_000_000,
      limit: 500_000,
      warnings,
    });
    expect(out).toBe(null);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Monte Carlo — convergence check against the analytical Normal answer
// and a sanity check on the empirical aggregate mean.
// ────────────────────────────────────────────────────────────────────────────

describe('monteCarloStopLoss', () => {
  it('aggregate mean converges to λ·E[X]', () => {
    // λ=15, Lognormal mean=300k CV=0.5  →  E[S] = 4.5M
    const out = monteCarloStopLoss({
      frequency: { lambda: 15 },
      severity: { type: 'lognormal', mean: 300_000, cv: 0.5 },
      attachment: 10_000_000,
      limit: 5_000_000,
      nTrials: 20_000,
      seed: 12345,
    });
    expect(out.aggMean).toBeCloseTo(4_500_000, -5); // ±50k tolerance
  });

  it('layer cost agrees with the Normal approximation when CLT holds', () => {
    // High λ + light severity → Normal approx is a good reference.
    // Compare MC mean to analytical exposure rating.
    const params = {
      frequency: { lambda: 100 },
      severity: { type: 'lognormal', mean: 50_000, cv: 0.4 },
      attachment: 5_000_000,
      limit: 2_000_000,
    };
    const analytical = exposureRatingStopLoss(params);
    const mc = monteCarloStopLoss({ ...params, nTrials: 30_000, seed: 7 });
    const rel = Math.abs(mc.annualLoss - analytical.annualLoss) / analytical.annualLoss;
    // Within 5% — MC noise + small skewness in the true compound dist.
    expect(rel).toBeLessThan(0.05);
  });

  it('is reproducible across reruns with the same seed', () => {
    const params = {
      frequency: { lambda: 20 },
      severity: { type: 'lognormal', mean: 200_000, cv: 0.6 },
      attachment: 4_000_000,
      limit: 3_000_000,
      nTrials: 5_000,
      seed: 999,
    };
    const a = monteCarloStopLoss(params);
    const b = monteCarloStopLoss(params);
    expect(a.annualLoss).toBe(b.annualLoss);
    expect(a.percentiles.p99).toBe(b.percentiles.p99);
    expect(a.aggMean).toBe(b.aggMean);
  });

  it('reports CV and hit frequency', () => {
    const out = monteCarloStopLoss({
      frequency: { lambda: 10 },
      severity: { type: 'lognormal', mean: 200_000, cv: 0.5 },
      attachment: 2_500_000,
      limit: 1_000_000,
      nTrials: 5_000,
      seed: 3,
    });
    expect(out.cv).toBeGreaterThan(0);
    expect(out.hitFrequency).toBeGreaterThan(0);
    expect(out.hitFrequency).toBeLessThanOrEqual(1);
    expect(out.percentiles.p50).toBeLessThanOrEqual(out.percentiles.p99);
  });

  it('handles heavy-tailed Pareto (where Normal approx is invalid)', () => {
    // α = 1.5 → infinite variance; Normal approx returns 0, MC gives a real number.
    const mc = monteCarloStopLoss({
      frequency: { lambda: 3 },
      severity: { type: 'pareto', alpha: 1.5, theta: 100_000 },
      attachment: 1_000_000,
      limit: 1_000_000,
      nTrials: 10_000,
      seed: 5,
    });
    expect(mc.annualLoss).toBeGreaterThan(0);
    // p99 should be at the layer ceiling for heavy tails (almost always full-limit).
    expect(mc.percentiles.p99).toBeLessThanOrEqual(1_000_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator — attachment dispatch, blending, loading.
// ────────────────────────────────────────────────────────────────────────────

describe('priceStopLoss orchestrator', () => {
  it('Stop Loss form: loss-ratio attachment + EPI → absolute attachment', () => {
    // EPI 10M, attach at 80% LR, limit 20% LR → D=8M, L=2M
    const out = priceStopLoss({
      attachmentLossRatio: 80,
      limitLossRatio: 20,
      epi: 10_000_000,
      yearlyAggregates: [
        { year: 2021, aggregate: 8_500_000 },
        { year: 2022, aggregate: 11_000_000 },
        { year: 2023, aggregate: 6_000_000 },
      ],
    });
    expect(out.attachment).toBe(8_000_000);
    expect(out.limit).toBe(2_000_000);
    // Year layer hits: 500k, 2M (capped), 0  → total 2.5M; /3 = 833,333
    expect(out.burningCost.annualLoss).toBeCloseTo(2_500_000 / 3, 4);
    expect(out.blended.annualLoss).toBeCloseTo(2_500_000 / 3, 4);
  });

  it('Aggregate XL form: absolute attachment + limit pass through unchanged', () => {
    const out = priceStopLoss({
      attachment: 12_000_000,
      limit: 5_000_000,
      yearlyAggregates: [{ year: 2023, aggregate: 18_000_000 }],
    });
    expect(out.attachment).toBe(12_000_000);
    expect(out.limit).toBe(5_000_000);
    expect(out.burningCost.annualLoss).toBe(5_000_000); // capped
  });

  it('Blends burning cost + exposure rating by weight', () => {
    // Construct identical attachment/limit; burning cost gives one
    // answer, exposure another → 50/50 blend lands in the middle.
    const args = {
      attachment: 4_000_000,
      limit: 3_000_000,
      yearlyAggregates: Array.from({ length: 10 }, (_, i) => ({
        year: 2014 + i,
        aggregate: 3_500_000,
      })),
      frequency: { lambda: 20 },
      severity: { type: 'lognormal', mean: 200_000, cv: 0.6 },
    };
    const burnOnly = priceStopLoss({ ...args, weights: { burningCost: 100, exposureRating: 0 } });
    const expOnly = priceStopLoss({ ...args, weights: { burningCost: 0, exposureRating: 100 } });
    const blend = priceStopLoss({ ...args, weights: { burningCost: 50, exposureRating: 50 } });
    expect(burnOnly.blended.annualLoss).toBe(0); // never breached
    expect(expOnly.blended.annualLoss).toBeGreaterThan(0);
    expect(blend.blended.annualLoss).toBeCloseTo(
      0.5 * burnOnly.blended.annualLoss + 0.5 * expOnly.blended.annualLoss,
      4,
    );
  });

  it('Monte Carlo toggle: off → monteCarlo is null, on → result is populated', () => {
    const args = {
      attachment: 4_000_000,
      limit: 3_000_000,
      frequency: { lambda: 20 },
      severity: { type: 'lognormal', mean: 200_000, cv: 0.6 },
    };
    const off = priceStopLoss(args);
    expect(off.monteCarlo).toBe(null);
    const on = priceStopLoss({
      ...args,
      useMonteCarlo: true,
      monteCarlo: { nTrials: 2_000, seed: 1 },
    });
    expect(on.monteCarlo).not.toBe(null);
    expect(on.monteCarlo.annualLoss).toBeGreaterThan(0);
  });

  it('Applies loading on top of the blended ROL', () => {
    const args = {
      attachment: 0,
      limit: 1_000_000,
      yearlyAggregates: [
        { year: 2022, aggregate: 100_000 },
        { year: 2023, aggregate: 200_000 },
      ],
      loading: 25, // 25% loading → divide pure rate by 0.75
    };
    const out = priceStopLoss(args);
    expect(out.blended.rol).toBeCloseTo(0.15, 6); // (100k + 200k)/2 / 1M
    expect(out.blended.totalRate).toBeCloseTo(0.15 / 0.75, 6);
  });

  it('Warns and yields zero when no method input is supplied', () => {
    const out = priceStopLoss({ attachment: 1_000_000, limit: 500_000 });
    expect(out.blended.annualLoss).toBe(0);
    expect(out.warnings.some((w) => /No pricing method produced output/i.test(w))).toBe(true);
  });

  it('Missing attachment without LR form → warning + zero attachment', () => {
    const out = priceStopLoss({
      limit: 1_000_000,
      yearlyAggregates: [{ year: 2023, aggregate: 5_000_000 }],
    });
    expect(out.attachment).toBe(0);
    expect(out.warnings.some((w) => /Attachment missing/i.test(w))).toBe(true);
    // With D=0, the whole loss falls in the layer (capped at limit 1M).
    expect(out.burningCost.annualLoss).toBe(1_000_000);
  });
});
