// Verifies the Pareto helpers used by the Large Loss and Cat Loss Pareto
// screens against pareto_fit_verification.xlsx.
//
// LossParetoScreen.jsx is the engine behind:
//   - PropLargeLossPareto      - PropCatLossPareto
//   - NpLargeLossPareto        - NpCatLossPareto
//
// Tabs verified:
//   1. Losses (input data — pulled into the JS arrays below)
//   2. Pareto MLE fit       → fitPareto
//   3. CDF and quantile     → paretoCDF / paretoQ
//   4. KS goodness-of-fit   → calcKS
//   5. Layer pricing        → calcLayerPrice    ← see note below
//
// HISTORICAL NOTE — Layer Pricing Formula Fix:
// An earlier version of LossParetoScreen.calcLayerPrice used a TRUNCATED
// LEV form  LEV(L) = (α·xm/(α-1)) · (1 − (xm/L)^(α-1))  which omitted the
// L · (xm/L)^α tail term, overstating layer severity by ~28% at typical
// retentions.  The workbook's Tab 5 was written against that earlier
// formula and therefore now disagrees with the corrected implementation.
// The truncated values that match the workbook (sev_workbook) are kept
// in the test below for traceability, but the assertions check the
// FULL-LEV values (sev_correct) that calcLayerPrice now produces — and
// that npPricingEngine.paretoLayerExpectedLoss has always produced.

import { describe, it, expect } from 'vitest';
import {
  fitPareto,
  paretoCDF,
  paretoQ,
  calcKS,
  calcLayerPrice,
} from '../screens/shared/LossParetoScreen';
import {
  paretoLEV as paretoLEV_npEngine,
  paretoLayerExpectedLoss,
} from './npPricingEngine.js';

const close = (a, b, tol = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// Tab 1 — inflated incurred losses (24 rows, sorted descending)
const INFLATED = [
  4963200, 3955600, 3877500, 3583800, 3517500,
  2948000, 2658600, 2553600, 2316000, 1954800,
  1914000, 1785000, 1547700, 1433900, 1303200,
  1195950, 1155200, 1033900,  930600,  804000,
   697950,  570150,  443100,  351750,
];

const XM = 1_000_000;
const YEARS = 10;
const EXPECTED_ALPHA = 1.283856;
const EXPECTED_N = 18;
const EXPECTED_FREQ = 1.8;
// The workbook displays α at 6dp but computes downstream quantities
// (Q(p), F(x), LEV) using full precision. Use the actual fitted α from
// the same data so downstream tests aren't artificially loose.
const ALPHA_FIT = fitPareto(INFLATED, XM).alpha;
// Sanity — fitted α matches the workbook's displayed α to 5 dp
const _alphaDispOk = Math.abs(ALPHA_FIT - EXPECTED_ALPHA) < 1e-5;

describe('Tab 2 — Pareto MLE fit (fitPareto)', () => {
  it('reproduces α = 1.283856 and n = 18 from the 24 inflated losses', () => {
    const { alpha, n } = fitPareto(INFLATED, XM);
    close(alpha, EXPECTED_ALPHA, 1e-5);
    expect(n).toBe(EXPECTED_N);
    close(n / YEARS, EXPECTED_FREQ, 1e-9);
  });

  it('Σ ln(x/xm) = 14.020265', () => {
    const above = INFLATED.filter(x => x >= XM);
    const s = above.reduce((acc, x) => acc + Math.log(x / XM), 0);
    close(s, 14.020265, 1e-4);
  });
});

describe('Tab 3 — CDF / survival samples (paretoCDF) and quantiles (paretoQ)', () => {
  // (x, F(x))
  const cdfSamples = [
    [   500_000, 0],
    [ 1_000_000, 0],
    [ 1_500_000, 0.405812],
    [ 2_000_000, 0.589304],
    [ 3_000_000, 0.755969],
    [ 5_000_000, 0.873345],
    [10_000_000, 0.947983],
    [20_000_000, 0.978637],
    [50_000_000, 0.993412],
    [100_000_000,0.997294],
  ];
  it.each(cdfSamples)('F(%i) ≈ %f', (x, expF) => {
    close(paretoCDF(x, ALPHA_FIT, XM), expF, 1e-5);
  });

  // (p, Q(p))
  const qSamples = [
    [0.5,   1_715_826.41],
    [0.75,  2_944_060.27],
    [0.9,   6_010_403.16],
    [0.95, 10_312_808.48],
    [0.99, 36_124_946.10],
    [0.995,61_984_136.63],
    [0.999,217_125_490.08],
  ];
  it.each(qSamples)('Q(%f) ≈ %f', (p, expQ) => {
    close(paretoQ(p, ALPHA_FIT, XM), expQ, 1);
  });

  it('Return periods T=2,5,10,25,50,100,250,500 match', () => {
    const rps = [
      [  2,   1_715_826.41],
      [  5,   3_502_920.29],
      [ 10,   6_010_403.16],
      [ 25,  12_270_450.58],
      [ 50,  21_053_963.19],
      [100,  36_124_946.10],
      [250,  73_750_354.92],
      [500, 126_542_806.81],
    ];
    for (const [T, expLoss] of rps) {
      // Workbook computes Q(1 − 1/T) which equals xm · T^(1/α)
      close(paretoQ(1 - 1/T, ALPHA_FIT, XM), expLoss, 1);
    }
  });

  it('Mean above xm = α·xm/(α−1) = 4,522,914', () => {
    const mean = ALPHA_FIT * XM / (ALPHA_FIT - 1);
    close(mean, 4_522_914.07, 1);
  });
});

describe('Tab 4 — KS goodness-of-fit (calcKS)', () => {
  it('D = 0.191405 and p ≈ 0.488', () => {
    const { ks, pValue } = calcKS(INFLATED, x => paretoCDF(x, ALPHA_FIT, XM), XM);
    close(ks, 0.191405, 1e-5);
    close(pValue, 0.487711, 1e-4);
  });
});

describe('Tab 5 — Layer pricing (calcLayerPrice, post-fix uses full LEV)', () => {
  // [retention, limit, sev_correct (full LEV), sev_workbook (obsolete, truncated)]
  // sev_correct verified by direct numerical integration on the Pareto density.
  // RPP_correct = λ · sev_correct, λ = 1.8.
  const layers = [
    [1_000_000,  1_000_000,   629_218.05,   807_825.33],
    [1_000_000,  4_000_000, 1_291_936.03, 1_658_659.82],
    [5_000_000,  5_000_000,   398_468.82,   511_576.63],
    [5_000_000, 10_000_000,   597_694.30,   767_353.50],
    [10_000_000,20_000_000,   490_941.72,   630_298.58],
  ];
  it.each(layers)('layer ret=%i lim=%i → corrected sev ≈ %s (was %s in workbook)',
    (ret, lim, sevCorrect, _sevWorkbook) => {
      const { severity, rpp } = calcLayerPrice(ALPHA_FIT, XM, EXPECTED_FREQ, ret, lim);
      close(severity, sevCorrect, 1);
      close(rpp, EXPECTED_FREQ * sevCorrect, 1);
    });
});

describe('Cross-check — both Pareto engines now AGREE (and match direct integration)', () => {
  // Same layers as above; this section asserts the two implementations
  // produce identical layer prices, eliminating the prior ~28% gap.
  const correctLayerLosses = [
    [1_000_000,  1_000_000,   629_218.05],
    [1_000_000,  4_000_000, 1_291_936.03],
    [5_000_000,  5_000_000,   398_468.82],
    [5_000_000, 10_000_000,   597_694.30],
    [10_000_000,20_000_000,   490_941.72],
  ];

  it('npPricingEngine.paretoLayerExpectedLoss matches direct integration (full LEV)', () => {
    for (const [ret, lim, expSev] of correctLayerLosses) {
      const expLayerLoss = paretoLayerExpectedLoss(
        ALPHA_FIT, XM, ret, lim, /*n=*/1, /*years=*/1,
      );
      close(expLayerLoss, expSev, 1);
    }
  });

  it('paretoLEV (full form) = (truncated form) + L·(xm/L)^α', () => {
    for (const L of [2_000_000, 5_000_000, 10_000_000, 20_000_000, 30_000_000]) {
      const trunc = (ALPHA_FIT * XM / (ALPHA_FIT - 1))
                  * (1 - Math.pow(XM / L, ALPHA_FIT - 1));
      const tail  = L * Math.pow(XM / L, ALPHA_FIT);
      const full  = paretoLEV_npEngine(ALPHA_FIT, XM, L);
      close(full, trunc + tail, 1);
    }
  });

  it('calcLayerPrice (screen) and paretoLayerExpectedLoss (engine) AGREE', () => {
    for (const [ret, lim] of correctLayerLosses.map(([r, l]) => [r, l])) {
      const screenSev = calcLayerPrice(ALPHA_FIT, XM, /*freq=*/1, ret, lim).severity;
      const engineSev = paretoLayerExpectedLoss(ALPHA_FIT, XM, ret, lim, /*n=*/1, /*years=*/1);
      close(screenSev, engineSev, 1);
    }
  });
});
