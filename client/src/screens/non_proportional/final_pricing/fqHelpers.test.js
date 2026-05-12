import { describe, expect, it } from 'vitest';
import {
  FQ_MARKET_A,
  FQ_MARKET_B,
  fqBuildPricingCurve,
  fqFitPowerLaw,
  fqGeomean,
  fqLayerToXY,
  fqPeerToXY,
  fqPriceLayerOnCurve,
  fqQuoteLayerDerived,
  fqToN,
} from './fqHelpers.js';

describe('final quote benchmark helpers', () => {
  it('uses the shared number parser', () => {
    expect(fqToN('1,000')).toBe(1000);
    expect(fqToN('1.234,56')).toBe(1234.56);
    expect(fqToN('(500)')).toBe(-500);
  });

  it('computes layer geomean when the top and attachment are positive', () => {
    expect(fqGeomean(1_000_000, 500_000)).toBeCloseTo(Math.sqrt(1_500_000 * 500_000));
    expect(fqGeomean(1_000_000, 0)).toBe(0);
    expect(fqGeomean(0, 500_000)).toBe(500_000);
  });

  it('converts layers to curve points using ROL preference order', () => {
    const fromRol = fqLayerToXY({ limit: '1,000,000', deductible: '500,000', egnpi: '10,000,000', rol: '5' });
    expect(fromRol.x).toBeGreaterThan(0);
    expect(fromRol.y).toBe(0.05);

    const fromRate = fqLayerToXY({ limit: 1_000_000, attachment: 500_000, egnpi: 10_000_000, rate: 2 });
    expect(fromRate.y).toBe(0.2);

    const fromEarnedPremium = fqLayerToXY({ limit: 1_000_000, attachment: 500_000, egnpi: 10_000_000, earnedPremium: 125_000, rate: 2 });
    expect(fromEarnedPremium.y).toBe(0.125);

    const fromUw = fqLayerToXY({ limit: 1_000_000, deductible: 500_000, egnpi: 10_000_000, uwPrice: 4 });
    expect(fromUw.y).toBe(0.04);
  });

  it('rejects incomplete layer and peer points', () => {
    expect(fqLayerToXY({ limit: 1_000_000, egnpi: 10_000_000, rol: 5 })).toBeNull();
    expect(fqPeerToXY({ limit: 1_000_000, ded: 0, egnpi: 10_000_000, rolPct: 5 })).toBeNull();
  });

  it('falls back to market curve when fewer than two valid points exist', () => {
    expect(fqFitPowerLaw([{ x: 0.2, y: 0.05 }])).toEqual({
      a: FQ_MARKET_A,
      b: FQ_MARKET_B,
      r2: null,
      calibrated: false,
      n: 1,
    });
  });

  it('calibrates a power curve from valid positive points', () => {
    const out = fqFitPowerLaw([
      { x: 0.10, y: 0.20 },
      { x: 0.20, y: 0.10 },
      { x: 0.40, y: 0.05 },
    ]);
    expect(out.calibrated).toBe(true);
    expect(out.n).toBe(3);
    expect(out.a).toBeGreaterThan(0);
    expect(out.b).toBeLessThanOrEqual(0);
    expect(out.r2).toBeGreaterThan(0.95);
  });

  it('prices a structure layer on a fitted curve using fallback EGNPI', () => {
    const out = fqPriceLayerOnCurve(
      { limit: 1_000_000, attachment: 500_000 },
      { a: 0.108, b: -1.074 },
      10_000_000,
    );
    expect(out.x).toBeCloseTo(Math.sqrt(1_500_000 * 500_000) / 10_000_000);
    expect(out.y).toBeGreaterThan(0);
    expect(out.premium).toBeCloseTo(out.y * 1_000_000);
  });

  it('derives quote structure total ROL from burn, pareto, exposure weights, and loading', () => {
    const out = fqQuoteLayerDerived({
      pureBurn: 3,
      pareto: 1,
      exposure: 6,
      wtBurn: 50,
      wtPareto: 10,
      loading: 20,
    });
    expect(out.burnPlusPareto).toBe(4);
    expect(out.wtExp).toBe(40);
    expect(out.totalRol).toBeCloseTo(((50 * 3 + 10 * 1 + 40 * 6) / 100) / 0.8);
  });

  it('builds final quote curve data from expiring layers and structures', () => {
    const curve = fqBuildPricingCurve({
      expLayers: [
        { limit: 1_000_000, attachment: 500_000, egnpi: 10_000_000, rol: 20 },
        { limit: 1_000_000, attachment: 1_500_000, egnpi: 10_000_000, rol: 10 },
      ],
      structures: [
        { layers: [{ limit: 2_000_000, attachment: 500_000 }] },
      ],
      npDetail: { estGnpi: 10_000_000 },
    });
    expect(curve.fit.calibrated).toBe(true);
    expect(curve.expPts).toHaveLength(2);
    expect(curve.flatStructPts).toHaveLength(1);
    expect(curve.flatStructPts[0].label).toBe('S1L1');
  });
});
