// paretoMonteCarlo.test.js
//
// The seeded Monte-Carlo aggregate-loss engine: determinism (same seed ⇒
// identical output), the GPD probability-weighted-moments fit, the
// paretoLEV reconciliation gate, layer + reinstatement caps, frequency
// over-dispersion, the estimation-risk toggle and the plotting outputs.

import { describe, it, expect } from 'vitest';
import {
  runParetoMonteCarlo,
  mulberry32,
  fitGpdPwm,
  invNormCdf,
  normCdf,
  fitSeverityWithCI,
  severityQuantile,
  severitySurvival,
  severityLayerMean,
  buildMeanExcess,
  buildSurvivalLogLog,
  buildQQ,
  ksStatistic,
} from './paretoMonteCarlo.js';

// Deterministic loss generators (seeded, so the tests never flicker).
function paretoSample(n, { alpha, xm, seed }) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = rng() || 1e-9;
    out.push(xm * Math.pow(u, -1 / alpha));   // u uniform ⇒ Pareto(alpha, xm)
  }
  return out;
}
function expSample(n, { mean, seed }) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(-mean * Math.log(rng() || 1e-9));
  return out;
}

const baseLayer = { attachment: 2_000_000, limit: 3_000_000, reinstatements: 1, reinstPct: 1, premium: 500_000 };

function baseParams(over = {}) {
  return {
    seed: 7,
    nSims: 5000,
    bootstrap: 200,
    losses: paretoSample(400, { alpha: 2.0, xm: 1_000_000, seed: 99 }),
    threshold: 1_000_000,
    severity: { family: 'PARETO' },
    frequency: { type: 'POISSON', lambda: 4, years: 10 },
    layer: baseLayer,
    ...over,
  };
}

describe('mulberry32', () => {
  it('is deterministic and stays in [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('normal helpers', () => {
  it('invNormCdf inverts the standard normal', () => {
    expect(invNormCdf(0.5)).toBeCloseTo(0, 6);
    expect(invNormCdf(0.975)).toBeCloseTo(1.959964, 3);
    expect(invNormCdf(0.025)).toBeCloseTo(-1.959964, 3);
  });
  it('normCdf matches known points', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 3);
  });
});

describe('fitGpdPwm', () => {
  it('recovers ξ≈0 (exponential) with σ≈mean', () => {
    const ex = expSample(4000, { mean: 250_000, seed: 5 });
    const { xi, sigma } = fitGpdPwm(ex);
    expect(Math.abs(xi)).toBeLessThan(0.1);
    expect(sigma).toBeGreaterThan(210_000);
    expect(sigma).toBeLessThan(290_000);
  });
  it('recovers ξ≈1/α on a Pareto tail', () => {
    // Pareto(α=2) excess over xm is GPD with ξ = 1/α = 0.5.
    const losses = paretoSample(4000, { alpha: 2.0, xm: 1_000_000, seed: 11 });
    const excesses = losses.map((x) => x - 1_000_000).filter((y) => y >= 0);
    const { xi } = fitGpdPwm(excesses);
    expect(xi).toBeGreaterThan(0.35);
    expect(xi).toBeLessThan(0.65);
  });
});

describe('runParetoMonteCarlo — determinism', () => {
  it('identical inputs ⇒ byte-identical output', () => {
    const a = runParetoMonteCarlo(baseParams());
    const b = runParetoMonteCarlo(baseParams());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('different seed ⇒ different aggregate mean', () => {
    const a = runParetoMonteCarlo(baseParams({ seed: 1 }));
    const b = runParetoMonteCarlo(baseParams({ seed: 2 }));
    expect(a.aggregate.mean).not.toBe(b.aggregate.mean);
  });
});

describe('runParetoMonteCarlo — reconciliation gate', () => {
  it('simulated mean matches analytic paretoLEV within MC standard error', () => {
    const r = runParetoMonteCarlo(baseParams({ nSims: 30000, resampleParams: false }));
    expect(r.reconciliation.analyticExpectedLoss).toBeGreaterThan(0);
    expect(r.reconciliation.withinTolerance).toBe(true);
    expect(Math.abs(r.reconciliation.zScore)).toBeLessThan(4);
  });
});

describe('runParetoMonteCarlo — distribution outputs', () => {
  const r = runParetoMonteCarlo(baseParams({ nSims: 20000 }));

  it('percentiles are monotonic and TVaR ≥ VaR', () => {
    const { p50, p90, p98, p99, p995 } = r.aggregate.percentiles;
    expect(p50).toBeLessThanOrEqual(p90);
    expect(p90).toBeLessThanOrEqual(p98);
    expect(p98).toBeLessThanOrEqual(p99);
    expect(p99).toBeLessThanOrEqual(p995);
    for (const t of r.aggregate.tail) expect(t.tvar).toBeGreaterThanOrEqual(t.var);
  });
  it('tail uses 1-in-{2,10,50,100,200} return periods', () => {
    expect(r.aggregate.tail.map((t) => t.rp)).toEqual([2, 10, 50, 100, 200]);
  });
  it('probabilities and moments are in range', () => {
    expect(r.aggregate.pAttach).toBeGreaterThan(0);
    expect(r.aggregate.pAttach).toBeLessThanOrEqual(1);
    expect(r.aggregate.pExhaust).toBeGreaterThanOrEqual(0);
    expect(r.aggregate.cov).toBeGreaterThan(0);
    expect(r.aggregate.eReinstUsed).toBeGreaterThanOrEqual(0);
  });
  it('emits a histogram and an ECDF for plotting', () => {
    expect(r.aggregate.histogram.bins.length).toBe(50);
    const totalCount = r.aggregate.histogram.bins.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(20000);
    expect(r.aggregate.ecdf.length).toBe(101);
    expect(r.aggregate.ecdf[0].p).toBe(0);
    expect(r.aggregate.ecdf[r.aggregate.ecdf.length - 1].p).toBe(1);
  });
  it('reports the fitted severity params with bootstrap CI bands', () => {
    expect(r.severity.params.alpha).toBeGreaterThan(0);
    const [lo, hi] = r.severity.ci.alpha;
    expect(lo).toBeLessThanOrEqual(hi);
    expect(lo).toBeLessThanOrEqual(r.severity.params.alpha);
    expect(hi).toBeGreaterThanOrEqual(r.severity.params.alpha);
  });
});

describe('runParetoMonteCarlo — layer + reinstatement terms', () => {
  it('caps the aggregate at limit × (1 + numReinst)', () => {
    const r = runParetoMonteCarlo(baseParams({ nSims: 20000 }));
    const aggLimit = baseLayer.limit * (1 + baseLayer.reinstatements);   // 6,000,000
    expect(r.layer.aggLimit).toBe(aggLimit);
    expect(r.aggregate.histogram.max).toBeLessThanOrEqual(aggLimit + 1e-6);
    expect(r.aggregate.eReinstUsed).toBeLessThanOrEqual(baseLayer.reinstatements + 1e-9);
    // Reinstatement premium accrues once the cap region is reached.
    expect(r.aggregate.eReinstPremium).toBeGreaterThan(0);
  });
  it('UNLIMITED reinstatements ⇒ no cap, no exhaustion', () => {
    const r = runParetoMonteCarlo(baseParams({ nSims: 20000, layer: { ...baseLayer, reinstatements: 'UNLIMITED' } }));
    expect(r.layer.aggLimit).toBeNull();
    expect(r.layer.reinstatements).toBe('UNLIMITED');
    expect(r.aggregate.pExhaust).toBe(0);
  });
});

describe('runParetoMonteCarlo — frequency over-dispersion', () => {
  it('NEGBIN yields a wider aggregate than POISSON (same mean)', () => {
    const common = { nSims: 20000, layer: { ...baseLayer, reinstatements: 'UNLIMITED' } };
    const pois = runParetoMonteCarlo(baseParams({ ...common, frequency: { type: 'POISSON', lambda: 5, years: 10 } }));
    const nb = runParetoMonteCarlo(baseParams({ ...common, frequency: { type: 'NEGBIN', lambda: 5, dispersion: 0.5, years: 10 } }));
    expect(nb.aggregate.sd).toBeGreaterThan(pois.aggregate.sd);
  });
});

describe('runParetoMonteCarlo — estimation-risk toggle', () => {
  it('resampleParams widens the aggregate distribution but stays deterministic', () => {
    const common = { nSims: 20000, layer: { ...baseLayer, reinstatements: 'UNLIMITED' } };
    const off = runParetoMonteCarlo(baseParams({ ...common, resampleParams: false }));
    const on1 = runParetoMonteCarlo(baseParams({ ...common, resampleParams: true }));
    const on2 = runParetoMonteCarlo(baseParams({ ...common, resampleParams: true }));
    expect(JSON.stringify(on1)).toBe(JSON.stringify(on2));   // still seeded
    expect(on1.aggregate.sd).toBeGreaterThan(off.aggregate.sd);
  });
});

describe('runParetoMonteCarlo — severity families', () => {
  it('defaults to GPD and runs', () => {
    const r = runParetoMonteCarlo(baseParams({ severity: undefined }));
    expect(r.family).toBe('GPD');
    expect(r.severity.params.sigma).toBeGreaterThan(0);
    expect(r.aggregate.mean).toBeGreaterThan(0);
  });
  it('LOGNORMAL runs and prices the layer', () => {
    const r = runParetoMonteCarlo(baseParams({ severity: { family: 'LOGNORMAL' } }));
    expect(r.family).toBe('LOGNORMAL');
    expect(r.severity.params.sigma).toBeGreaterThan(0);
    expect(r.aggregate.mean).toBeGreaterThanOrEqual(0);
  });
  it('warns when too few losses clear the threshold', () => {
    const r = runParetoMonteCarlo(baseParams({ losses: [1_000_000, 2_000_000], threshold: 1_000_000, severity: { family: 'GPD' } }));
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('honours a severity.params override (reproducible from stored params)', () => {
    const base = baseParams({ nSims: 30000 });
    const fitted = runParetoMonteCarlo(base);
    const heavierAlpha = fitted.severity.params.alpha * 0.5;   // smaller α ⇒ heavier tail
    const overridden = runParetoMonteCarlo({ ...base, severity: { family: 'PARETO', params: { alpha: heavierAlpha } } });
    expect(overridden.severity.params.alpha).toBeCloseTo(heavierAlpha, 6);
    expect(overridden.aggregate.mean).toBeGreaterThan(fitted.aggregate.mean);
    // Same override + seed ⇒ byte-identical (the audit-trail guarantee).
    const again = runParetoMonteCarlo({ ...base, severity: { family: 'PARETO', params: { alpha: heavierAlpha } } });
    expect(JSON.stringify(again)).toBe(JSON.stringify(overridden));
  });
});

describe('severity fit + diagnostics (UI helpers)', () => {
  const losses = paretoSample(300, { alpha: 2.0, xm: 1_000_000, seed: 33 });
  const threshold = 1_000_000;

  it('fitSeverityWithCI returns params + ordered bootstrap CI bands', () => {
    const f = fitSeverityWithCI('PARETO', losses, threshold, { bootstrap: 200, seed: 1 });
    expect(f.family).toBe('PARETO');
    expect(f.n).toBeGreaterThan(0);
    expect(f.params.alpha).toBeGreaterThan(0);
    const [lo, hi] = f.ci.alpha;
    expect(lo).toBeLessThanOrEqual(hi);
    expect(lo).toBeLessThanOrEqual(f.params.alpha + 1e-9);
    expect(hi).toBeGreaterThanOrEqual(f.params.alpha - 1e-9);
  });

  it('fitSeverityWithCI is deterministic in its seed', () => {
    const a = fitSeverityWithCI('GPD', losses, threshold, { bootstrap: 150, seed: 7 });
    const b = fitSeverityWithCI('GPD', losses, threshold, { bootstrap: 150, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('severityQuantile is increasing in p and severitySurvival its inverse-ish', () => {
    const params = { alpha: 2, xm: threshold };
    const q50 = severityQuantile('PARETO', params, threshold, 0.5);
    const q90 = severityQuantile('PARETO', params, threshold, 0.9);
    expect(q90).toBeGreaterThan(q50);
    // S(Q(p)) ≈ 1 − p for the same family.
    expect(severitySurvival('PARETO', params, threshold, q90)).toBeCloseTo(0.1, 2);
    // Below threshold nothing has "exceeded" yet.
    expect(severitySurvival('PARETO', params, threshold, threshold * 0.5)).toBe(1);
  });

  it('severityLayerMean is bounded by the limit and rises with limit', () => {
    const params = { alpha: 2, xm: threshold };
    const small = severityLayerMean('PARETO', params, threshold, 2_000_000, 1_000_000);
    const big = severityLayerMean('PARETO', params, threshold, 2_000_000, 5_000_000);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThanOrEqual(1_000_000);
    expect(big).toBeGreaterThan(small);
  });

  it('buildMeanExcess returns an increasing curve for a heavy tail', () => {
    const me = buildMeanExcess(losses, 20);
    expect(me.length).toBeGreaterThan(2);
    expect(me[me.length - 1].e).toBeGreaterThan(me[0].e);   // Pareto mean-excess increases
  });

  it('buildSurvivalLogLog returns positive empirical + fitted survival points', () => {
    const f = fitSeverityWithCI('PARETO', losses, threshold, { bootstrap: 0 });
    const s = buildSurvivalLogLog(losses, 'PARETO', f.params, threshold);
    expect(s.empirical.length).toBeGreaterThan(0);
    expect(s.fitted.length).toBeGreaterThan(0);
    for (const pt of s.empirical) { expect(pt.s).toBeGreaterThan(0); expect(pt.s).toBeLessThanOrEqual(1); }
  });

  it('buildQQ lines up theoretical vs empirical (monotone, finite)', () => {
    const f = fitSeverityWithCI('PARETO', losses, threshold, { bootstrap: 0 });
    const qq = buildQQ(losses, 'PARETO', f.params, threshold);
    expect(qq.length).toBeGreaterThan(10);
    expect(qq[qq.length - 1].empirical).toBeGreaterThan(qq[0].empirical);
    for (const pt of qq) expect(Number.isFinite(pt.theoretical)).toBe(true);
  });

  it('ksStatistic is small when the fitted family matches the data', () => {
    const f = fitSeverityWithCI('PARETO', losses, threshold, { bootstrap: 0 });
    const { d, n } = ksStatistic(losses, 'PARETO', f.params, threshold);
    expect(n).toBeGreaterThan(0);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(0.15);   // Pareto fit to Pareto data ⇒ tight K-S
  });
});
