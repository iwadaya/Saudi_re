import { describe, it, expect } from 'vitest';
import { calculateMunichChainLadder } from './munichChainLadder.js';

/**
 * Sample triangles drawn from the Quarg & Mack (2004) paper-style
 * setup: paid develops up from a low base, incurred starts higher
 * and converges down. Standard CL gives wide paid/incurred ultimate
 * gaps; MCL should pull them closer.
 */
const PAID = [
  [1000, 1500, 1750, 1850],
  [1100, 1700, 2000, null],
  [1200, 1900, null, null],
  [1300, null, null, null],
];
const INCURRED = [
  [2000, 2050, 2000, 1950],
  [2200, 2300, 2200, null],
  [2400, 2500, null,  null],
  [2600, null, null,  null],
];
const YEARS = [2020, 2021, 2022, 2023];

describe('calculateMunichChainLadder', () => {
  it('returns null for missing input', () => {
    expect(calculateMunichChainLadder({ paid: null, incurred: INCURRED })).toBeNull();
    expect(calculateMunichChainLadder({ paid: PAID, incurred: null })).toBeNull();
  });

  it('produces standard chain-ladder LDFs for paid and incurred separately', () => {
    const out = calculateMunichChainLadder({ paid: PAID, incurred: INCURRED, years: YEARS });
    // Paid col 0: (1500+1700+1900) / (1000+1100+1200) = 5100/3300 ≈ 1.5455
    expect(out.paidPattern[0]).toBeCloseTo(5100 / 3300, 6);
    // Incurred col 0: (2050+2300+2500)/(2000+2200+2400) = 6850/6600 ≈ 1.0379
    expect(out.incurredPattern[0]).toBeCloseTo(6850 / 6600, 6);
    expect(out.paidCdfs).toHaveLength(out.paidPattern.length + 1);
    expect(out.incurredCdfs).toHaveLength(out.incurredPattern.length + 1);
  });

  it('produces a projection per origin year', () => {
    const out = calculateMunichChainLadder({ paid: PAID, incurred: INCURRED, years: YEARS });
    expect(out.projections).toHaveLength(YEARS.length);
    expect(out.projections.map(p => p.year)).toEqual(YEARS);
  });

  it('fully developed origin year keeps its observed paid/incurred', () => {
    const out = calculateMunichChainLadder({ paid: PAID, incurred: INCURRED, years: YEARS });
    const p2020 = out.projections[0];
    expect(p2020.ultimatePaid).toBeCloseTo(1850, 6);
    expect(p2020.ultimateIncurred).toBeCloseTo(1950, 6);
    expect(p2020.ibnrPaid).toBe(0);
    expect(p2020.ibnrIncurred).toBe(0);
  });

  it('MCL adjusts ultimates away from standard CL when current P/I deviates from the column mean', () => {
    // Build a triangle where one row's paid is consistently low relative
    // to incurred (P/I < column mean) — MCL should bias that row's paid
    // ultimate *upward* relative to vanilla CL, since negative residual
    // correlation says "low paid today implies higher future link ratios".
    const paid = [
      [1000, 1500, 1800, 1900],  // P/I ≈ 0.50 → 0.71 → 0.78 → 0.83
      [1100, 1700, 2050, null],
      [1200, 1900, null,  null],
      [800,  null, null,  null], // ← paid runs LOW for 2023
    ];
    const incurred = [
      [2000, 2100, 2300, 2280],
      [2200, 2300, 2400, null],
      [2400, 2500, null,  null],
      [2600, null, null,  null], // matching incurred is normal
    ];
    const out = calculateMunichChainLadder({ paid, incurred, years: YEARS });
    // Standard CL paid ultimate for 2023:
    const stdPaid2023 = paid[3][0] * out.paidCdfs[0];
    const mclPaid2023 = out.projections[3].ultimatePaid;
    // MCL must move the paid ultimate (in either direction) — it cannot
    // equal standard CL when the current Q deviates strongly from qBar.
    expect(Math.abs(mclPaid2023 - stdPaid2023)).toBeGreaterThan(1);
  });

  it('handles a row with no observations → zero ultimate, no NaN', () => {
    const paid = [...PAID, [null, null, null, null]];
    const incurred = [...INCURRED, [null, null, null, null]];
    const years = [...YEARS, 2024];
    const out = calculateMunichChainLadder({ paid, incurred, years });
    const last = out.projections[out.projections.length - 1];
    expect(last.ultimatePaid).toBe(0);
    expect(last.ultimateIncurred).toBe(0);
    expect(Number.isFinite(last.ibnrPaid)).toBe(true);
    expect(Number.isFinite(last.ibnrIncurred)).toBe(true);
  });

  it('falls back to standard CL when residual variance is degenerate', () => {
    // Perfectly proportional triangles → all link ratios identical →
    // zero residual variance → MCL cannot estimate λ.
    const flatP = [
      [100, 150, 175, 187.5],
      [110, 165, 192.5, null],
      [120, 180, null, null],
      [130, null, null, null],
    ];
    const flatI = flatP.map(row => row.map(v => v == null ? null : v * 1.2));
    const out = calculateMunichChainLadder({ paid: flatP, incurred: flatI, years: YEARS });
    expect(out.warnings.length).toBeGreaterThan(0);
    // Projections should still be finite — we fall back to vanilla CL.
    for (const p of out.projections) {
      expect(Number.isFinite(p.ultimatePaid)).toBe(true);
      expect(Number.isFinite(p.ultimateIncurred)).toBe(true);
    }
  });

  it('Pearson correlation parameters are finite for a well-behaved triangle', () => {
    const out = calculateMunichChainLadder({ paid: PAID, incurred: INCURRED, years: YEARS });
    expect(Number.isFinite(out.lambdaP)).toBe(true);
    expect(Number.isFinite(out.lambdaI)).toBe(true);
  });
});
