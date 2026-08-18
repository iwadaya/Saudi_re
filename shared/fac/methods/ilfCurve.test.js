import { describe, it, expect } from 'vitest';
import {
  alphaFromDoublingLoading, doublingLoadingFromAlpha, ilfEvaluator,
  ilfLayerLossCost, claimsMadeStepFactor, ilfLossCost,
} from './ilfCurve.js';

const POWER = (doubling, basic = 1_000_000) => ({
  kind: 'POWER', curve_code: 'TEST-POWER', basic_limit: basic,
  params: { doubling_loading: doubling },
});
const BASE_RATE = {
  basis_unit: 'TURNOVER', basis_divisor: 1_000_000,
  basic_limit: 1_000_000, loss_cost_per_unit: 500,
};

describe('Riebesell doubling loading', () => {
  it('converts a doubling loading to the curve exponent', () => {
    // "+20% each time the limit doubles" → α = log₂(1.2)
    expect(alphaFromDoublingLoading(0.20)).toBeCloseTo(Math.log2(1.2), 12);
    expect(alphaFromDoublingLoading(0.20)).toBeCloseTo(0.263034, 5);
  });

  it('round-trips back to the doubling loading', () => {
    expect(doublingLoadingFromAlpha(alphaFromDoublingLoading(0.35))).toBeCloseTo(0.35, 12);
  });

  it('is zero when doubling the limit costs nothing more', () => {
    expect(alphaFromDoublingLoading(0)).toBe(0);
  });

  it('rejects a loading that would wipe out the premium', () => {
    expect(() => alphaFromDoublingLoading(-1)).toThrow(/exceed/);
  });
});

describe('ilfEvaluator — power curve', () => {
  it('is 1.0 at the basic limit, by construction', () => {
    expect(ilfEvaluator(POWER(0.20))(1_000_000)).toBeCloseTo(1, 12);
  });

  it('applies the doubling loading at every doubling, which is Riebesell\'s rule', () => {
    const ILF = ilfEvaluator(POWER(0.20));
    // The whole point of the rule: the ratio is the same at every doubling.
    expect(ILF(2_000_000) / ILF(1_000_000)).toBeCloseTo(1.2, 10);
    expect(ILF(4_000_000) / ILF(2_000_000)).toBeCloseTo(1.2, 10);
    expect(ILF(16_000_000) / ILF(8_000_000)).toBeCloseTo(1.2, 10);
  });

  it('is concave — each extra layer of limit costs less than the one below', () => {
    const ILF = ilfEvaluator(POWER(0.20));
    const first = ILF(2_000_000) - ILF(1_000_000);
    const second = ILF(3_000_000) - ILF(2_000_000);
    expect(second).toBeLessThan(first);
  });

  it('accepts an explicit alpha instead of a doubling loading', () => {
    const ILF = ilfEvaluator({ kind: 'POWER', basic_limit: 1_000_000, params: { alpha: 0.5 } });
    expect(ILF(4_000_000)).toBeCloseTo(2, 12);       // 4^0.5
  });

  it('refuses a curve with no parameters rather than assuming one', () => {
    expect(() => ilfEvaluator({ kind: 'POWER', basic_limit: 1_000_000, params: {} }))
      .toThrow(/alpha or doubling loading/);
  });

  it('refuses a curve with no basic limit', () => {
    expect(() => ilfEvaluator({ kind: 'POWER', basic_limit: 0, params: { alpha: 0.3 } }))
      .toThrow(/basic limit/);
  });
});

describe('ilfEvaluator — tabulated', () => {
  const TAB = {
    kind: 'TABULATED', basic_limit: 1_000_000,
    points: [
      { limit_amount: 1_000_000, ilf: 1.0 },
      { limit_amount: 2_000_000, ilf: 1.25 },
      { limit_amount: 5_000_000, ilf: 1.60 },
    ],
  };

  it('interpolates between published points', () => {
    const ILF = ilfEvaluator(TAB);
    expect(ILF(1_500_000)).toBeCloseTo(1.125, 12);
  });

  it('holds flat above the table rather than extrapolating a severity tail', () => {
    // Extrapolating past the data is exactly the guess this module refuses
    // to make elsewhere.
    const ILF = ilfEvaluator(TAB);
    expect(ILF(50_000_000)).toBeCloseTo(1.60, 12);
  });

  it('scales proportionally below the lowest point', () => {
    expect(ilfEvaluator(TAB)(500_000)).toBeCloseTo(0.5, 12);
  });

  it('needs at least two points', () => {
    expect(() => ilfEvaluator({ kind: 'TABULATED', basic_limit: 1e6, points: [{ limit_amount: 1e6, ilf: 1 }] }))
      .toThrow(/at least two points/);
  });
});

describe('ilfLayerLossCost', () => {
  const ILF = ilfEvaluator(POWER(0.20));

  it('is the difference of the curve at the two ends of the layer', () => {
    const cost = ilfLayerLossCost({
      basicLimitLossCost: 100_000, attachment: 1_000_000, limit: 1_000_000, ILF,
    });
    expect(cost).toBeCloseTo(100_000 * (ILF(2_000_000) - ILF(1_000_000)), 9);
  });

  it('collapses to the ordinary increased-limits calculation for a primary policy', () => {
    const cost = ilfLayerLossCost({ basicLimitLossCost: 100_000, attachment: 0, limit: 5_000_000, ILF });
    expect(cost).toBeCloseTo(100_000 * ILF(5_000_000), 9);
  });

  it('splits a tower into pieces that sum back to the whole', () => {
    const whole = ilfLayerLossCost({ basicLimitLossCost: 100_000, attachment: 0, limit: 10_000_000, ILF });
    const parts = [[0, 1e6], [1e6, 4e6], [5e6, 5e6]]
      .map(([d, l]) => ilfLayerLossCost({ basicLimitLossCost: 100_000, attachment: d, limit: l, ILF }))
      .reduce((a, b) => a + b, 0);
    expect(parts).toBeCloseTo(whole, 6);
  });

  it('costs a higher layer less than the one below it', () => {
    const low = ilfLayerLossCost({ basicLimitLossCost: 100_000, attachment: 1e6, limit: 1e6, ILF });
    const high = ilfLayerLossCost({ basicLimitLossCost: 100_000, attachment: 9e6, limit: 1e6, ILF });
    expect(high).toBeLessThan(low);
    expect(high).toBeGreaterThan(0);
  });

  it('is nil without a limit or a basic-limit cost', () => {
    expect(ilfLayerLossCost({ basicLimitLossCost: 0, attachment: 0, limit: 1e6, ILF })).toBe(0);
    expect(ilfLayerLossCost({ basicLimitLossCost: 100, attachment: 0, limit: 0, ILF })).toBe(0);
  });
});

describe('claimsMadeStepFactor', () => {
  const steps = [0.4, 0.7, 0.85, 0.95, 1.0];

  it('leaves an occurrence policy alone', () => {
    expect(claimsMadeStepFactor({ claimsMade: false, steps })).toEqual({ factor: 1, basis: 'OCCURRENCE' });
  });

  it('steps up as the retroactive period lengthens', () => {
    expect(claimsMadeStepFactor({ claimsMade: true, retroYears: 0, steps }).factor).toBe(0.4);
    expect(claimsMadeStepFactor({ claimsMade: true, retroYears: 2, steps }).factor).toBe(0.85);
  });

  it('treats a retro period longer than the table as mature', () => {
    expect(claimsMadeStepFactor({ claimsMade: true, retroYears: 20, steps }).factor).toBe(1.0);
  });

  it('never prices a claims-made policy up on an invented step table', () => {
    const out = claimsMadeStepFactor({ claimsMade: true, retroYears: 0, steps: null });
    expect(out.factor).toBe(1);
    expect(out.basis).toBe('CLAIMS_MADE_NO_STEPS');
  });
});

describe('ilfLossCost — the candidate', () => {
  it('builds the basic-limit cost from the exposure base and steps it to the limit', () => {
    const out = ilfLossCost({
      exposureBase: 50_000_000,          // 50m turnover
      baseRate: BASE_RATE,               // 500 per 1m at a 1m basic limit
      curve: POWER(0.20),
      attachment: 0, limit: 5_000_000,
    });
    expect(out.available).toBe(true);
    expect(out.diagnostics.basic_limit_loss_cost).toBeCloseTo(25_000, 9);
    const ILF = ilfEvaluator(POWER(0.20));
    expect(out.lossCost).toBeCloseTo(25_000 * ILF(5_000_000), 6);
    expect(out.ratePm).toBeCloseTo((out.lossCost / 50_000_000) * 1000, 9);
  });

  it('prices an excess layer below the primary', () => {
    const args = { exposureBase: 50_000_000, baseRate: BASE_RATE, curve: POWER(0.20) };
    const primary = ilfLossCost({ ...args, attachment: 0, limit: 5_000_000 });
    const excess = ilfLossCost({ ...args, attachment: 5_000_000, limit: 5_000_000 });
    expect(excess.lossCost).toBeLessThan(primary.lossCost);
    expect(excess.lossCost).toBeGreaterThan(0);
  });

  it('discounts a young claims-made policy when the class has steps', () => {
    const curve = { ...POWER(0.20), params: { doubling_loading: 0.20, claims_made_steps: [0.4, 0.7, 1.0] } };
    const occurrence = ilfLossCost({ exposureBase: 1e7, baseRate: BASE_RATE, curve, limit: 1e6 });
    const claimsMade = ilfLossCost({
      exposureBase: 1e7, baseRate: BASE_RATE, curve, limit: 1e6,
      claimsMade: true, retroYears: 0,
    });
    expect(claimsMade.lossCost).toBeCloseTo(occurrence.lossCost * 0.4, 9);
    expect(claimsMade.diagnostics.claims_made_basis).toBe('CLAIMS_MADE_YEAR_1');
  });

  it('loads for defence costs in addition, and only when a factor is given', () => {
    const args = { exposureBase: 1e7, baseRate: BASE_RATE, curve: POWER(0.20), limit: 1e6 };
    const inside = ilfLossCost(args);
    const declared = ilfLossCost({ ...args, defenceCostsInAddition: true, defenceCostsFactor: 1.15 });
    const noFactor = ilfLossCost({ ...args, defenceCostsInAddition: true });
    expect(declared.lossCost).toBeCloseTo(inside.lossCost * 1.15, 9);
    // No factor loaded ⇒ treated as inside the limit, which is the
    // assumption that does not inflate the price.
    expect(noFactor.lossCost).toBeCloseTo(inside.lossCost, 9);
  });

  it('counts each reinstated aggregate as another limit of exposure', () => {
    const args = { exposureBase: 1e7, baseRate: BASE_RATE, curve: POWER(0.20), limit: 1e6 };
    const one = ilfLossCost(args);
    const two = ilfLossCost({ ...args, aggregateReinstatements: 1 });
    expect(two.lossCost).toBeCloseTo(one.lossCost * 2, 9);
  });

  it('says exactly what is missing rather than pricing at zero', () => {
    const base = { exposureBase: 1e7, baseRate: BASE_RATE, curve: POWER(0.20), limit: 1e6 };
    expect(ilfLossCost({ ...base, exposureBase: 0 }).unavailableReason).toMatch(/turnover, payroll or fee/);
    expect(ilfLossCost({ ...base, baseRate: null }).unavailableReason).toMatch(/base rate is loaded/);
    expect(ilfLossCost({ ...base, curve: null }).unavailableReason).toMatch(/ILF curve is loaded/);
    expect(ilfLossCost({ ...base, limit: 0 }).unavailableReason).toMatch(/policy limit/);
    for (const bad of [{ exposureBase: 0 }, { baseRate: null }, { curve: null }, { limit: 0 }]) {
      expect(ilfLossCost({ ...base, ...bad }).lossCost).toBeUndefined();
    }
  });
});
