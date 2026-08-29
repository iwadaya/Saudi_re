// distributions.test.js — KS scoring basis for the severity-fit ranking (F59).
//
// calcKS compares every candidate against the CONDITIONAL empirical CDF of
// losses ≥ xm. Pareto / exponential / Weibull CDFs are naturally
// threshold-conditional (F(xm) = 0), but the lognormal's support extends
// below xm, so scoring it on its UNCONDITIONAL CDF ranked the four families
// on different bases and could flip which distribution the screen selects
// (min KS). fitAll now wraps the lognormal with conditionalCDF:
//   Fc(x) = (F(x) − F(xm)) / (1 − F(xm)).

import { describe, expect, it } from 'vitest';
import {
  calcKS,
  conditionalCDF,
  expCDF,
  fitAll,
  fitExponential,
  fitLognormal,
  lognormalCDF,
  paretoCDF,
} from './distributions.js';

// The pareto_fit_verification.xlsx loss set (24 inflated losses, 18 ≥ xm=1M)
// also pinned by utils/paretoFit.verifyExcel.test.js and the screen golden
// master.
const WORKBOOK = [
  4963200, 3955600, 3877500, 3583800, 3517500,
  2948000, 2658600, 2553600, 2316000, 1954800,
  1914000, 1785000, 1547700, 1433900, 1303200,
  1195950, 1155200, 1033900,  930600,  804000,
   697950,  570150,  443100,  351750,
];
const XM = 1_000_000;

describe('conditionalCDF', () => {
  it('is zero at the threshold and rescales the tail mass to [0, 1]', () => {
    const { mu, sigma } = fitLognormal(WORKBOOK, XM); // μ=14.5944, σ=0.4682
    const F0 = lognormalCDF(XM, mu, sigma);
    expect(F0).toBeCloseTo(0.048083, 6); // unconditional mass below xm ≠ 0
    const fc = conditionalCDF(x => lognormalCDF(x, mu, sigma), XM);
    expect(fc(XM)).toBe(0);
    // Hand check at x = 2M: Fc = (F(2M) − F0) / (1 − F0)
    const f2m = lognormalCDF(2_000_000, mu, sigma);
    expect(fc(2_000_000)).toBeCloseTo((f2m - F0) / (1 - F0), 12);
    expect(fc(1e12)).toBeCloseTo(1, 6);
    expect(fc(XM - 1)).toBe(0); // below threshold
  });

  it('a fit with all mass below the threshold scores as a total misfit', () => {
    const fc = conditionalCDF(() => 1, XM); // degenerate: F(xm) = 1
    expect(fc(2_000_000)).toBe(1);
    const { ks } = calcKS([1_500_000, 2_000_000], fc, XM);
    expect(ks).toBe(1); // |0/n − 1| at the first point
  });

  it('leaves an already-conditional CDF unchanged (F(xm) = 0)', () => {
    const base = x => paretoCDF(x, 1.5, XM);
    const fc = conditionalCDF(base, XM);
    for (const x of [XM, 1_500_000, 3_000_000, 10_000_000]) {
      expect(fc(x)).toBeCloseTo(base(x), 12);
    }
  });
});

describe('lognormal KS on the workbook set — conditioned basis (F59)', () => {
  it('pins conditional D = 0.139651 (p = 0.943582) vs the old unconditional D = 0.124580', () => {
    const { mu, sigma } = fitLognormal(WORKBOOK, XM);
    const uncond = calcKS(WORKBOOK, x => lognormalCDF(x, mu, sigma), XM);
    const cond = calcKS(WORKBOOK, conditionalCDF(x => lognormalCDF(x, mu, sigma), XM), XM);
    expect(uncond.ks).toBeCloseTo(0.124580, 6);
    expect(uncond.pValue).toBe(1); // capped
    expect(cond.ks).toBeCloseTo(0.139651, 6);
    expect(cond.pValue).toBeCloseTo(0.943582, 6);
    // fitAll must score the lognormal on the CONDITIONAL basis
    const fits = fitAll(WORKBOOK, XM);
    const ln = fits.find(f => f.key === 'lognormal');
    expect(ln.ks.ks).toBeCloseTo(cond.ks, 12);
    // Pareto is untouched (its CDF was already conditional): D = 0.191405
    expect(fits.find(f => f.key === 'pareto').ks.ks).toBeCloseTo(0.191405, 6);
  });
});

describe('mixed-basis ranking flip (F59)', () => {
  // Six round tail losses, xm = 1M:
  const LOSSES = [1_000_000, 1_200_000, 1_350_000, 1_550_000, 1_900_000, 2_300_000];
  //
  // Exponential fit (hand-derived): mean excess over xm =
  //   (0 + 0.2 + 0.35 + 0.55 + 0.9 + 1.3)M / 6 = 3.3M/6 = 550,000 → λ = 1/550,000.
  // Its KS is EXACTLY 1/6: at x = xm the empirical CDF jumps to 1/6 while the
  // model CDF is 0 (and no later gap exceeds it).
  //
  // Lognormal fit: μ = mean(ln x) = 14.214751, σ = 0.278306 →
  //   F(xm) = 0.075710 (7.6% of unconditional mass sits below the threshold).
  // KS unconditional = 0.141661; conditioned = 0.191513.
  //
  // So the min-KS winner FLIPS:
  //   as-coded (mixed basis):  lognormal 0.141661 < exponential 1/6 → lognormal
  //   fixed (common basis):    exponential 1/6 < lognormal 0.191513 → exponential
  // (pareto 0.199945 and weibull 0.265931 trail in both rankings.)

  it('exponential λ = 1/550,000 and KS = 1/6 exactly', () => {
    const ex = fitExponential(LOSSES, XM);
    expect(1 / ex.lambda).toBeCloseTo(550_000, 6);
    const { ks } = calcKS(LOSSES, x => expCDF(x, ex.lambda, XM), XM);
    expect(ks).toBeCloseTo(1 / 6, 12);
  });

  it('the old mixed basis would have picked lognormal; the common basis picks exponential', () => {
    const { mu, sigma } = fitLognormal(LOSSES, XM);
    expect(lognormalCDF(XM, mu, sigma)).toBeCloseTo(0.075710, 6);

    const uncond = calcKS(LOSSES, x => lognormalCDF(x, mu, sigma), XM).ks;
    const cond = calcKS(LOSSES, conditionalCDF(x => lognormalCDF(x, mu, sigma), XM), XM).ks;
    expect(uncond).toBeCloseTo(0.141661, 6);
    expect(cond).toBeCloseTo(0.191513, 6);

    const fits = fitAll(LOSSES, XM);
    const ksOf = key => fits.find(f => f.key === key).ks.ks;
    expect(ksOf('exponential')).toBeCloseTo(1 / 6, 12);
    expect(ksOf('lognormal')).toBeCloseTo(cond, 12);
    expect(ksOf('pareto')).toBeCloseTo(0.199945, 6);
    expect(ksOf('weibull')).toBeCloseTo(0.265931, 6);

    // Fixed ranking: exponential wins (same rule as useLossParetoDerived.bestFit)
    const best = [...fits].sort((a, b) => a.ks.ks - b.ks.ks)[0].key;
    expect(best).toBe('exponential');
    // The pre-fix mixed basis inverted this pair: uncond lognormal beat exp.
    expect(uncond).toBeLessThan(1 / 6);
    expect(cond).toBeGreaterThan(1 / 6);
  });
});
