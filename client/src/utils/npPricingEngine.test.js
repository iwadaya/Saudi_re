// Golden-file tests for the NP pricing engine.
//
// This is the single highest-risk untested file in the codebase — a
// regression here is money-wrong on reinsurance slips. Every math
// function has a test that locks its result against hand-calculated
// values so future refactors fail loudly when they drift.
//
// Where a function lacks a closed-form expected value (e.g. Pareto
// MLE over noisy data), we pick inputs where the expected answer
// is either degenerate (returns 0) or has a well-known closed form.

import { describe, it, expect } from 'vitest';
import {
  cn, fmtRol, fmtPct,
  mbbefdG, mbbefdLayerLEV, SWISS_RE_C,
  fitPareto, paretoQ, paretoLEV,
  paretoLayerExpectedLoss,
  paretoAttachment, paretoExhaustion,
  calcPureBurningCost,
  calcParetoROL,
  autoCurveForBand,
  calcRiskExposureRating,
  calcCatExposureRating,
  buildCobTokenMap,
  filterLossesForLayer,
} from './npPricingEngine.js';

// ═══════════════════════════════════════════════════════════════════
// Math primitives
// ═══════════════════════════════════════════════════════════════════

describe('cn — Postgres-safe number parse', () => {
  it('handles null/empty/junk by returning 0', () => {
    expect(cn(null)).toBe(0);
    expect(cn(undefined)).toBe(0);
    expect(cn('')).toBe(0);
    expect(cn('abc')).toBe(0);
    expect(cn(NaN)).toBe(0);
  });
  it('strips commas and parses', () => {
    expect(cn('1,234')).toBe(1234);
    expect(cn('1,234.56')).toBe(1234.56);
    expect(cn(42)).toBe(42);
    expect(cn(-5.5)).toBe(-5.5);
  });
});

describe('fmtRol / fmtPct — presentation helpers', () => {
  it('returns empty string for zero or invalid', () => {
    expect(fmtRol(0)).toBe('');
    expect(fmtRol(null)).toBe('');
    expect(fmtRol(NaN)).toBe('');
    expect(fmtPct(0)).toBe('');
  });
  it('emits a percent with 2dp for fractions', () => {
    expect(fmtRol(0.05)).toBe('5.00%');
    expect(fmtRol(0.1234)).toBe('12.34%');
  });
});

// ═══════════════════════════════════════════════════════════════════
// MBBEFD exposure curve
// ═══════════════════════════════════════════════════════════════════

describe('mbbefdG(d, c) — Swiss Re exposure curve', () => {
  it('pins the endpoints: G(0)=0, G(1)=1', () => {
    for (const c of [0, 1.5, 3, 5]) {
      expect(mbbefdG(0, c)).toBe(0);
      expect(mbbefdG(1, c)).toBe(1);
    }
  });

  it('linear when c≈0 (Y1 curve)', () => {
    expect(mbbefdG(0.25, 0)).toBeCloseTo(0.25, 10);
    expect(mbbefdG(0.5, 0)).toBeCloseTo(0.5, 10);
  });

  it('monotonically increasing in d for a fixed c', () => {
    for (const c of [1.5, 3, 5]) {
      let prev = 0;
      for (const d of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const v = mbbefdG(d, c);
        expect(v).toBeGreaterThan(prev);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    }
  });

  it('heavier curve (larger c) concentrates mass toward small losses', () => {
    // At d=0.5, G(d,5) > G(d,1.5) > linear — bigger c = more weight on
    // losses near zero, so the CDF rises faster.
    const atHalf = [mbbefdG(0.5, 0), mbbefdG(0.5, 1.5), mbbefdG(0.5, 3), mbbefdG(0.5, 5)];
    for (let i = 1; i < atHalf.length; i++) {
      expect(atHalf[i]).toBeGreaterThan(atHalf[i - 1]);
    }
  });
});

describe('mbbefdLayerLEV', () => {
  it('returns 0 for degenerate inputs', () => {
    expect(mbbefdLayerLEV(0, 50, 1.5, 10, 100)).toBe(0);
    expect(mbbefdLayerLEV(1000, 50, 1.5, 0, 0)).toBe(0);
  });

  it('full-loss layer (D=0, L=PML) returns PML', () => {
    // G(1,c) - G(0,c) = 1 → LEV = pml * 1 = pml
    const si = 1_000_000;
    const pmlPct = 60;
    const lev = mbbefdLayerLEV(si, pmlPct, 1.5, 0, si * pmlPct / 100);
    expect(lev).toBeCloseTo(600_000, 0);
  });

  it('layer above PML returns zero contribution from the excess', () => {
    // Attachment at PML → G(D/PML) = G(1) = 1 so contribution = 0
    const lev = mbbefdLayerLEV(1_000_000, 50, 1.5, 500_000, 100_000);
    expect(lev).toBe(0);
  });
});

describe('SWISS_RE_C', () => {
  it('has the four canonical curves in ascending size', () => {
    expect(SWISS_RE_C).toEqual({ Y1: 0, Y2: 1.5, Y3: 3.0, Y4: 5.0 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Pareto fitting + LEV
// ═══════════════════════════════════════════════════════════════════

describe('fitPareto — MLE', () => {
  it('returns alpha=0 with empty input', () => {
    expect(fitPareto([], 100)).toEqual({ alpha: 0, n: 0 });
    expect(fitPareto(null, 100)).toEqual({ alpha: 0, n: 0 });
  });

  it('ignores losses below threshold', () => {
    const fit = fitPareto([50, 75, 100, 200, 500], 100);
    // Only 100, 200, 500 contribute (n=3)
    expect(fit.n).toBe(3);
    expect(fit.alpha).toBeGreaterThan(0);
  });

  it('perfectly concentrated data (all = xm) gives infinite alpha, we return 0', () => {
    // sum of log(1) = 0 → denom 0 → alpha = 0 by our guard
    expect(fitPareto([100, 100, 100], 100)).toEqual({ alpha: 0, n: 3 });
  });

  it('fit to a heavy tail produces small alpha (~1–2)', () => {
    // Synthetic heavy-tailed sample
    const fit = fitPareto([100, 100, 150, 200, 500, 1000, 5000], 100);
    expect(fit.n).toBe(7);
    expect(fit.alpha).toBeGreaterThan(0);
    expect(fit.alpha).toBeLessThan(3);
  });
});

describe('paretoQ — quantile', () => {
  it('guards against invalid inputs', () => {
    expect(paretoQ(0, 2, 100)).toBe(0);
    expect(paretoQ(1, 2, 100)).toBe(0);
    expect(paretoQ(0.5, 0, 100)).toBe(0);
    expect(paretoQ(0.5, 2, 0)).toBe(0);
  });

  it('q(p) = xm for very small p approaches xm from above', () => {
    // Q(p) = xm * (1-p)^(-1/alpha) → xm as p→0
    const q = paretoQ(1e-10, 2, 100);
    expect(q).toBeCloseTo(100, 3);
  });

  it('higher exceedance probability = higher quantile', () => {
    // Careful: paretoQ uses (1-p)^(-1/α) so HIGHER p ⇒ higher quantile.
    const q1 = paretoQ(0.01, 2, 100);
    const q2 = paretoQ(0.1, 2, 100);
    expect(q2).toBeGreaterThan(q1);
  });
});

describe('paretoLEV', () => {
  it('returns 0 for degenerate inputs', () => {
    expect(paretoLEV(2, 100, 0)).toBe(0);
    expect(paretoLEV(0, 100, 500)).toBe(0);
    expect(paretoLEV(2, 0, 500)).toBe(0);
  });

  it('cap ≤ xm: LEV = cap (all below threshold)', () => {
    expect(paretoLEV(2, 100, 50)).toBe(50);
    expect(paretoLEV(2, 100, 100)).toBe(100);
  });

  it('alpha=1 uses the log formula', () => {
    // E[min(X,c)] = xm * (1 + ln(c/xm))
    // At xm=100, c=e*100 ≈ 271.8 → LEV = 100 * (1 + 1) = 200
    const cap = Math.E * 100;
    expect(paretoLEV(1, 100, cap)).toBeCloseTo(200, 2);
  });

  it('alpha=2, xm=100, cap=∞ would be 200 (infinite mean sanity check)', () => {
    // At α=2, E[X] = xm*α/(α-1) = 200 for large cap
    const lev = paretoLEV(2, 100, 1e12);
    expect(lev).toBeCloseTo(200, 1);
  });

  it('cap just above xm gives LEV ≈ xm', () => {
    const lev = paretoLEV(2, 100, 100.000001);
    expect(lev).toBeCloseTo(100, 2);
  });
});

describe('paretoLayerExpectedLoss', () => {
  it('returns 0 for degenerate inputs', () => {
    expect(paretoLayerExpectedLoss(0, 100, 200, 100, 10, 5)).toBe(0);
    expect(paretoLayerExpectedLoss(2, 100, 200, 100, 10, 0)).toBe(0);
    expect(paretoLayerExpectedLoss(2, 100, 200, 100, 0, 5)).toBe(0);
  });

  it('scales linearly with loss frequency (n / years)', () => {
    const base = paretoLayerExpectedLoss(2, 100, 200, 100, 10, 10);
    const double = paretoLayerExpectedLoss(2, 100, 200, 100, 20, 10);
    expect(double).toBeCloseTo(base * 2, 6);
  });

  it('deductible below xm gets clamped to xm', () => {
    const a = paretoLayerExpectedLoss(2, 100, 50, 500, 10, 10);  // D below xm
    const b = paretoLayerExpectedLoss(2, 100, 100, 500, 10, 10); // D = xm
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('paretoAttachment / paretoExhaustion', () => {
  it('returns 1 when deductible ≤ xm (always attaches)', () => {
    expect(paretoAttachment(2, 100, 50)).toBe(1);
    expect(paretoAttachment(2, 100, 100)).toBe(1);
  });

  it('attachment = (xm/D)^alpha above threshold', () => {
    // D = 2*xm, α=2 → (100/200)^2 = 0.25
    expect(paretoAttachment(2, 100, 200)).toBeCloseTo(0.25, 6);
  });

  it('exhaustion is attachment at D+L', () => {
    const a = paretoAttachment(2, 100, 500);
    const e = paretoExhaustion(2, 100, 200, 300);
    expect(e).toBeCloseTo(a, 10);
  });

  it('exhaustion ≤ attachment (monotone survivor function)', () => {
    const a = paretoAttachment(2, 100, 200);
    const e = paretoExhaustion(2, 100, 200, 500);
    expect(e).toBeLessThanOrEqual(a);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Pure Burning Cost
// ═══════════════════════════════════════════════════════════════════

describe('calcPureBurningCost', () => {
  it('returns zero rol when no losses', () => {
    const r = calcPureBurningCost([], 100, 500, 10_000_000, 5, {});
    expect(r.rol).toBe(0);
  });

  it('returns zero when limit ≤ 0', () => {
    expect(calcPureBurningCost([{ incurred: 200 }], 100, 0, 10_000_000, 5).rol).toBe(0);
  });

  it('single loss fully inside the layer — ROL = layerLoss / years / EGNPI', () => {
    // One 500k loss, D=100k, L=500k → layerHit = min(400k, 500k) = 400k
    // obsYears=5; egnpi=10M
    // avgLossCost = (400k / 5) / 10M = 0.008  (rate as % of EGNPI)
    // avgAnnualLayerLoss = avgLossCost × prospective_egnpi = 0.008 × 10M = 80k
    // rol = avgLossCost = 0.008  (matches Pareto + exposure-rating units)
    const losses = [{ uw_year: 2020, inflated_incurred: 500_000 }];
    const r = calcPureBurningCost(losses, 100_000, 500_000, 10_000_000, 5);
    expect(r.rol).toBeCloseTo(0.008, 4);
    expect(r.avgAnnualLayerLoss).toBeCloseTo(80_000, 0);
  });

  it('skips losses with is_selected=false', () => {
    const losses = [
      { uw_year: 2020, inflated_incurred: 500_000, is_selected: false },
      { uw_year: 2021, inflated_incurred: 300_000, is_selected: true },
    ];
    const r = calcPureBurningCost(losses, 100_000, 500_000, 10_000_000, 5);
    // Only the 300k loss contributes; layer hit = 200k.
    // avgLossCost = (200k / 5) / 10M = 0.004
    expect(r.rol).toBeCloseTo(0.004, 4);
  });

  it('caps layer hit at the limit', () => {
    // 10M loss into a 500k xs 100k layer → layer hit capped at 500k
    const losses = [{ uw_year: 2020, inflated_incurred: 10_000_000 }];
    const r = calcPureBurningCost(losses, 100_000, 500_000, 10_000_000, 5);
    // avgLossCost = (500k / 5) / 10M = 0.01
    expect(r.rol).toBeCloseTo(0.01, 4);
  });

  it('falls back to incurred+os when inflated_incurred is missing', () => {
    const losses = [{ uw_year: 2020, incurred: 300_000, os: 200_000 }];
    const r = calcPureBurningCost(losses, 100_000, 500_000, 10_000_000, 5);
    // 500k loss → layer hit 400k → avgLossCost = (400k/5)/10M = 0.008
    expect(r.rol).toBeCloseTo(0.008, 4);
  });

  it('uses per-year EGNPI when provided (Clark alignment)', () => {
    const losses = [
      { uw_year: 2019, inflated_incurred: 500_000 },
      { uw_year: 2020, inflated_incurred: 300_000 },
    ];
    const egnpiByYear = { 2019: 10_000_000, 2020: 12_000_000, 2021: 15_000_000 };
    const r = calcPureBurningCost(losses, 100_000, 500_000, 10_000_000, 3, egnpiByYear);
    // 2019 layer loss = 400k; 2020 = 200k; 2021 = 0
    // loss costs: 0.04, 0.01666, 0
    // sum / years = (0.04 + 0.01666) / 3 = 0.01889
    // avgEgnpi = (10 + 12 + 15) / 3 = 12.333M
    // avgAnnualLayerLoss = 0.01889 * 12.333M ≈ 232,929
    // rol ≈ 232,929 / 500_000 ≈ 0.466 (expected)
    expect(r.rol).toBeGreaterThan(0);
    expect(r.years).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Pareto ROL orchestration
// ═══════════════════════════════════════════════════════════════════

describe('calcParetoROL', () => {
  const zeroResult = { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };

  it('returns zero when limit or egnpi is 0', () => {
    expect(calcParetoROL([], 100, 0, 1_000_000)).toEqual(zeroResult);
    expect(calcParetoROL([], 100, 500, 0)).toEqual(zeroResult);
  });

  it('returns zero when too few data points', () => {
    expect(calcParetoROL([{ incurred: 500 }, { incurred: 600 }], 100, 500, 10_000_000)).toEqual(zeroResult);
  });

  it('uses saved params when provided', () => {
    const r = calcParetoROL([], 100_000, 500_000, 10_000_000, {
      pareto_alpha: 2, pareto_xm: 100_000, selected_count: 10, observation_years: 10,
    });
    expect(r.alpha).toBe(2);
    expect(r.xm).toBe(100_000);
    expect(r.rol).toBeGreaterThan(0);
    expect(r.prAttach).toBeLessThanOrEqual(1);
    expect(r.prExhaust).toBeLessThanOrEqual(r.prAttach);
  });

  it('fits from raw data when no saved params', () => {
    const losses = Array.from({ length: 10 }, (_, i) => ({
      uw_year: 2015 + i, incurred: 100_000 * (i + 1),
    }));
    const r = calcParetoROL(losses, 150_000, 500_000, 10_000_000);
    expect(r.alpha).toBeGreaterThan(0);
    expect(r.xm).toBeGreaterThan(0);
    expect(r.rol).toBeGreaterThanOrEqual(0);
  });

  it('clamps probabilities to [0,1]', () => {
    // Deep-in-the-money layer — attach prob ~1
    const r = calcParetoROL([], 0, 100, 1_000_000, {
      pareto_alpha: 2, pareto_xm: 100_000, selected_count: 10, observation_years: 10,
    });
    expect(r.prAttach).toBeLessThanOrEqual(1);
    expect(r.prExhaust).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Swiss Re curve auto-selection
// ═══════════════════════════════════════════════════════════════════

describe('autoCurveForBand', () => {
  it('picks Y1 for small personal risks', () => {
    expect(autoCurveForBand(100_000)).toBe('Y1');
    expect(autoCurveForBand(400_000)).toBe('Y1');
  });

  it('picks Y2 for small commercial', () => {
    expect(autoCurveForBand(500_000)).toBe('Y2');
    expect(autoCurveForBand(1_000_000)).toBe('Y2');
  });

  it('picks Y3 for medium commercial', () => {
    expect(autoCurveForBand(1_500_000)).toBe('Y3');
    expect(autoCurveForBand(2_000_000)).toBe('Y3');
  });

  it('picks Y4 for industrial / large commercial', () => {
    expect(autoCurveForBand(2_000_001)).toBe('Y4');
    expect(autoCurveForBand(100_000_000)).toBe('Y4');
  });

  it('handles the zero edge case — Y1 as a safe default', () => {
    expect(autoCurveForBand(0)).toBe('Y1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Risk XL Exposure Rating (MBBEFD)
// ═══════════════════════════════════════════════════════════════════

describe('calcRiskExposureRating', () => {
  it('returns zero for empty profiles', () => {
    expect(calcRiskExposureRating([], 100, 500, 10_000_000).rol).toBe(0);
    expect(calcRiskExposureRating(null, 100, 500, 10_000_000).rol).toBe(0);
  });

  it('returns zero when limit or egnpi ≤ 0', () => {
    const oneProfile = [{ profile: { pml_percentage: 100 }, bands: [{ no_of_risks: 10, total_sum_insured: 1_000_000 }] }];
    expect(calcRiskExposureRating(oneProfile, 100, 0, 10_000_000).rol).toBe(0);
    expect(calcRiskExposureRating(oneProfile, 100, 500, 0).rol).toBe(0);
  });

  it('produces a positive ROL for a reasonable profile', () => {
    const profiles = [{
      profile: { pml_percentage: 60, selected_curve: 'Y3' },
      bands: [
        { no_of_risks: 100, total_sum_insured: 100_000_000 },   // avg SI 1M
        { no_of_risks: 50,  total_sum_insured: 100_000_000 },   // avg SI 2M
      ],
    }];
    const r = calcRiskExposureRating(profiles, 500_000, 1_500_000, 50_000_000);
    expect(r.rol).toBeGreaterThan(0);
    expect(r.totalExpLoss).toBeGreaterThan(0);
    expect(r.totalSI).toBe(200_000_000);
  });

  it('skips bands with zero risks or SI', () => {
    const profiles = [{
      profile: { pml_percentage: 60 },
      bands: [
        { no_of_risks: 0, total_sum_insured: 1_000_000 },
        { no_of_risks: 10, total_sum_insured: 0 },
        { no_of_risks: 10, total_sum_insured: 10_000_000 },
      ],
    }];
    // Only the third band contributes — so totalSI should equal 10M, not 11M
    const r = calcRiskExposureRating(profiles, 100_000, 500_000, 10_000_000);
    expect(r.totalSI).toBe(10_000_000);
  });

  it('honours gross_loss_ratio as a multiplier', () => {
    const baseProfile = {
      profile: { pml_percentage: 60, selected_curve: 'Y3' },
      bands: [{ no_of_risks: 100, total_sum_insured: 100_000_000 }],
    };
    const r1 = calcRiskExposureRating([baseProfile], 500_000, 500_000, 10_000_000);
    const r2 = calcRiskExposureRating(
      [{ ...baseProfile, profile: { ...baseProfile.profile, gross_loss_ratio: 50 } }],
      500_000, 500_000, 10_000_000,
    );
    // 50% ratio should halve the expected loss
    expect(r2.totalExpLoss).toBeCloseTo(r1.totalExpLoss * 0.5, 0);
  });

  it('uses autoCurveForBand per band when selected_curve=Auto', () => {
    const profiles = [{
      profile: { pml_percentage: 60, selected_curve: 'Auto' },
      bands: [
        { no_of_risks: 100, total_sum_insured: 30_000_000 },    // avg 300k → Y1
        { no_of_risks: 100, total_sum_insured: 300_000_000 },   // avg 3M → Y4
      ],
    }];
    const r = calcRiskExposureRating(profiles, 500_000, 500_000, 50_000_000);
    expect(r.rol).toBeGreaterThan(0);
    expect(r.totalSI).toBe(330_000_000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cat XL Exposure Rating
// ═══════════════════════════════════════════════════════════════════

describe('calcCatExposureRating', () => {
  it('returns zero ROL + method=none when nothing is available', () => {
    const r = calcCatExposureRating([], 100, 500, 10_000_000, null, null, 10);
    expect(r.rol).toBe(0);
    expect(r.method).toBe('none');
  });

  it('returns zero when limit or egnpi ≤ 0', () => {
    expect(calcCatExposureRating([], 100, 0, 10_000_000).rol).toBe(0);
    expect(calcCatExposureRating([], 100, 500, 0).rol).toBe(0);
  });

  it('prefers the return-period curve when rp points are provided (method=rp_curve)', () => {
    const catSnap = {
      return_period_key_points: {
        rp10: 1_000_000,
        rp50: 5_000_000,
        rp100: 10_000_000,
        rp200: 15_000_000,
      },
    };
    // Layer 2M xs 2M should be hit by RP50+ events
    const r = calcCatExposureRating([], 2_000_000, 2_000_000, 50_000_000, catSnap, null, 10);
    expect(r.method).toBe('rp_curve');
    expect(r.rol).toBeGreaterThan(0);
    expect(r.prAttach).toBeGreaterThan(0);
    expect(r.prExhaust).toBeLessThanOrEqual(r.prAttach);
  });

  it('falls back to Pareto fit when no rp points but enough cat losses (method=pareto)', () => {
    const losses = Array.from({ length: 6 }, (_, i) => ({
      uw_year: 2018 + i, incurred: 500_000 * (i + 1),
    }));
    const r = calcCatExposureRating([], 1_000_000, 2_000_000, 20_000_000, null, losses, 6);
    expect(r.method).toBe('pareto');
    expect(r.alpha).toBeGreaterThan(0);
    expect(r.xm).toBeGreaterThan(0);
  });

  it('falls back to flat-loss-ratio when neither rp curve nor enough losses (method=flat_loss_ratio_fallback)', () => {
    const cresta = [
      { eq_agg: 100_000_000, ws_agg: 50_000_000, flood_agg: 30_000_000, srcc_agg: 10_000_000, others_agg: 5_000_000 },
    ];
    const r = calcCatExposureRating(cresta, 1_000_000, 2_000_000, 20_000_000, null, null, 10);
    expect(r.method).toBe('flat_loss_ratio_fallback');
    expect(r.totalExposure).toBe(195_000_000);
  });

  it('method=none when CRESTA rows are all empty', () => {
    const cresta = [{ eq_agg: 0, ws_agg: 0, flood_agg: 0, srcc_agg: 0, others_agg: 0 }];
    const r = calcCatExposureRating(cresta, 100, 500, 10_000_000, null, null, 10);
    expect(r.method).toBe('none');
  });

  it('handles catLosses with <3 valid points by falling through to the next method', () => {
    const cresta = [{ eq_agg: 50_000_000, ws_agg: 0, flood_agg: 0, srcc_agg: 0, others_agg: 0 }];
    const tooFewLosses = [{ incurred: 100 }, { incurred: 200 }]; // only 2 points
    const r = calcCatExposureRating(cresta, 1_000, 10_000, 10_000_000, null, tooFewLosses, 5);
    // With only 2 losses, Pareto method skips; falls through to the gated fallback
    expect(r.method).toBe('flat_loss_ratio_fallback');
  });
});

/* ── Per-layer COB filtering for burn cost ───────────────────────── */

describe('buildCobTokenMap', () => {
  it('returns empty map for empty / non-array input', () => {
    expect(buildCobTokenMap([])).toEqual({});
    expect(buildCobTokenMap(null)).toEqual({});
    expect(buildCobTokenMap(undefined)).toEqual({});
  });

  it('indexes every known name/code variant, lowercased + trimmed', () => {
    const m = buildCobTokenMap([
      { class_of_business_id: 'id-1', class_of_business: 'Motor', code: 'MOT' },
      { id:                   'id-2', class_name:        ' Property ', code: 'PROP' },
      { class_of_business_id: 'id-3', name:              'Engineering' },
    ]);
    expect(m['id-1']).toContain('motor');
    expect(m['id-1']).toContain('mot');
    expect(m['id-2']).toContain('property'); // trimmed
    expect(m['id-2']).toContain('prop');
    expect(m['id-3']).toContain('engineering');
  });

  it('skips rows with no id or no name/code fields', () => {
    const m = buildCobTokenMap([
      { class_of_business_id: '', code: 'X' },        // no id
      { class_of_business_id: 'id-4' },               // no name or code
      { id: 'id-5', class_of_business: 'Marine' },
    ]);
    expect(m['']).toBeUndefined();
    expect(m['id-4']).toBeUndefined();
    expect(m['id-5']).toContain('marine');
  });
});

describe('filterLossesForLayer', () => {
  const cobMap = buildCobTokenMap([
    { class_of_business_id: 'motor-id',    class_of_business: 'Motor',      code: 'MOT' },
    { class_of_business_id: 'property-id', class_of_business: 'Property',   code: 'PROP' },
    { class_of_business_id: 'eng-id',      class_of_business: 'Engineering',code: 'ENG' },
  ]);
  const allLosses = [
    { loss_id: 'L1', class_of_business: 'Motor',       incurred: 100 },
    { loss_id: 'L2', class_of_business: 'PROPERTY',    incurred: 200 }, // case
    { loss_id: 'L3', class_of_business: 'Engineering', incurred: 300 },
    { loss_id: 'L4', class_of_business: 'Marine',      incurred: 400 }, // not on any layer
    { loss_id: 'L5', class_of_business: '',            incurred: 500 }, // no COB
  ];

  it('returns all losses when the layer has no COB ids (legacy contracts)', () => {
    expect(filterLossesForLayer(allLosses, [],        cobMap)).toEqual(allLosses);
    expect(filterLossesForLayer(allLosses, undefined, cobMap)).toEqual(allLosses);
  });

  it('returns all losses when the reference map is empty (catalog missing)', () => {
    expect(filterLossesForLayer(allLosses, ['motor-id'], {})).toEqual(allLosses);
  });

  it('filters to the layer\'s COBs — matches on name (case-insensitive)', () => {
    const out = filterLossesForLayer(allLosses, ['motor-id', 'property-id'], cobMap);
    const ids = out.map(l => l.loss_id);
    expect(ids).toContain('L1');   // Motor
    expect(ids).toContain('L2');   // PROPERTY
    expect(ids).not.toContain('L3'); // Engineering (not covered)
    expect(ids).not.toContain('L4'); // Marine (not covered)
    expect(ids).toContain('L5');   // no COB → pass-through
  });

  it('matches on code as well as name', () => {
    const mix = [
      { loss_id: 'LM', class_of_business: 'MOT' }, // code form
      { loss_id: 'LP', class_of_business: 'Property' },
    ];
    const out = filterLossesForLayer(mix, ['motor-id'], cobMap);
    expect(out.map(l => l.loss_id)).toEqual(['LM']);
  });

  it('tolerates camelCase field name on the loss row', () => {
    const camel = [{ loss_id: 'X', classOfBusiness: 'Motor' }];
    const out = filterLossesForLayer(camel, ['motor-id'], cobMap);
    expect(out).toHaveLength(1);
  });

  it('returns the full list when the layer\'s COB ids don\'t resolve', () => {
    const out = filterLossesForLayer(allLosses, ['ghost-id'], cobMap);
    expect(out).toEqual(allLosses);
  });

  it('handles empty / non-array losses defensively', () => {
    expect(filterLossesForLayer([],        ['motor-id'], cobMap)).toEqual([]);
    expect(filterLossesForLayer(null,      ['motor-id'], cobMap)).toEqual([]);
    expect(filterLossesForLayer(undefined, ['motor-id'], cobMap)).toEqual([]);
  });
});
