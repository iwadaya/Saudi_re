// Golden-file tests for the NP pricing formatters + math. These are
// the lowest-level building blocks in the pricing engine — a
// regression here shows up as wrong money on slips. If anyone edits
// a formula, the test fail tells them which caller breaks.

import { describe, it, expect } from 'vitest';
import {
  toN, fmtC, pct, fmtM, money, fmtPctV,
  emptyLayerPricing,
  deriveCombinedUwPrice,
  deriveComponentTotal,
} from './formatters.js';

describe('toN', () => {
  it('parses plain numbers', () => {
    expect(toN(42)).toBe(42);
    expect(toN('3.14')).toBe(3.14);
    expect(toN('-5')).toBe(-5);
  });
  it('strips formatting (commas, %, spaces)', () => {
    expect(toN('1,234.56')).toBe(1234.56);
    expect(toN('  12.5 %  ')).toBe(12.5);
    expect(toN('$1,000,000')).toBe(1000000);
  });
  it('delegates to the shared flexible parser', () => {
    expect(toN('(500)')).toBe(-500);
    expect(toN('1.234,56')).toBe(1234.56);
  });
  it('returns 0 for null/undefined/empty/junk', () => {
    expect(toN(null)).toBe(0);
    expect(toN(undefined)).toBe(0);
    expect(toN('')).toBe(0);
    expect(toN('N/A')).toBe(0);
  });
});

describe('pct', () => {
  it('formats finite numbers to N decimals + %', () => {
    expect(pct(12)).toBe('12.00%');
    expect(pct(12.345)).toBe('12.35%');
    expect(pct(12.345, 1)).toBe('12.3%');
    expect(pct(0)).toBe('0.00%');
  });
  it('returns em-dash for NaN/Infinity', () => {
    expect(pct(NaN)).toBe('–');
    expect(pct(Infinity)).toBe('–');
  });
});

describe('fmtM', () => {
  it('abbreviates millions + thousands', () => {
    expect(fmtM(1_500_000)).toBe('1.5M');
    expect(fmtM(250_000)).toBe('250K');
    expect(fmtM(999)).toBe('999');
  });
  it('handles negatives and zero', () => {
    expect(fmtM(-1_200_000)).toBe('-1.2M');
    expect(fmtM(0)).toBe('–');
  });
});

describe('money', () => {
  it('formats with currency prefix + commas, rounded', () => {
    expect(money(1234567.89, 'USD')).toBe('USD 1,234,568');
    expect(money(0, 'USD')).toBe('—');
    expect(money(null, 'EUR')).toBe('—');
  });
});

describe('fmtPctV', () => {
  it('hides zero, shows em-dash', () => {
    expect(fmtPctV(0)).toBe('—');
    expect(fmtPctV(3.14)).toBe('3.14%');
    expect(fmtPctV(3.14, 1)).toBe('3.1%');
  });
});

describe('fmtC', () => {
  it('adds thousands separators', () => {
    expect(fmtC(1234567)).toBe('1,234,567');
  });
});

describe('emptyLayerPricing', () => {
  it('returns a blank layer with the expected shape', () => {
    const l = emptyLayerPricing(0);
    expect(l.layer).toBe('L1');
    expect(l.risk).toBe(false);
    expect(l.cat).toBe(false);
    expect(l.riskWeightBurn).toBe('50');
    expect(l.riskWeightExposure).toBe('50');
    expect(l.riskLoading).toBe('15');
    expect(l.catWeightBurn).toBe('50');
  });

  it('uses 1-indexed layer names', () => {
    expect(emptyLayerPricing(2).layer).toBe('L3');
  });

  it('has all 34 pricing fields the NP screen depends on', () => {
    // Acts as a schema lock — adding a field is fine, quietly
    // removing one usually isn't (screens read them by name).
    const required = [
      'layer', 'limit', 'deductible', 'risk', 'cat',
      'riskPureBurn', 'riskPareto', 'riskAvgBurnPareto', 'riskExposure',
      'riskWeightBurn', 'riskWeightExposure', 'riskLoading',
      'riskTotalPrice', 'riskUwPrice', 'riskPrAttach', 'riskPrExhaust',
      'catPureBurn', 'catPareto', 'catAvgBurnPareto', 'catExposure',
      'catWeightBurn', 'catWeightExposure', 'catLoading',
      'catTotalPrice', 'catUwPrice', 'catPrAttach', 'catPrExhaust',
      'totalPrice', 'uwPrice',
      'reinsurerPricing', 'leadPricing', 'expiringPricing', 'historicalMargin',
      'technicalRatio',
    ];
    const l = emptyLayerPricing(0);
    for (const k of required) expect(l).toHaveProperty(k);
  });
});

describe('deriveCombinedUwPrice', () => {
  it('sums risk + cat when both active', () => {
    const l = { risk: true, cat: true, riskUwPrice: '10', catUwPrice: '5' };
    expect(deriveCombinedUwPrice(l)).toBe(15);
  });
  it('returns only risk when cat inactive', () => {
    expect(deriveCombinedUwPrice({ risk: true, cat: false, riskUwPrice: '7', catUwPrice: '99' })).toBe(7);
  });
  it('returns only cat when risk inactive', () => {
    expect(deriveCombinedUwPrice({ risk: false, cat: true, riskUwPrice: '99', catUwPrice: '4' })).toBe(4);
  });
  it('falls back to totalPrice when uwPrice not set', () => {
    expect(deriveCombinedUwPrice({ risk: true, cat: false, riskUwPrice: '', riskTotalPrice: '12' })).toBe(12);
    expect(deriveCombinedUwPrice({ risk: false, cat: true, catUwPrice: '', catTotalPrice: '8' })).toBe(8);
  });
  it('returns 0 when no component is active', () => {
    expect(deriveCombinedUwPrice({ risk: false, cat: false, riskUwPrice: '10', catUwPrice: '20' })).toBe(0);
  });
});

describe('deriveComponentTotal (3-way blend)', () => {
  // burn=8, pareto=2, exposure=10, wB=50, wP=0, wE=50, loading=20:
  //   blended = (50·8 + 0·2 + 50·10) / 100 = 9
  //   loaded  = 9 / (1 - 0.2) = 11.25
  it('three-way weighted blend with loading', () => {
    expect(deriveComponentTotal('8', '2', '10', '50', '0', '50', '20')).toBeCloseTo(11.25);
  });

  it('weights need not sum to 100 (normalised by Σ weights)', () => {
    // Same ratio (50/0/50), just larger numbers — same answer
    expect(deriveComponentTotal('8', '2', '10', '80', '0', '80', '20')).toBeCloseTo(11.25);
  });

  it('clamps weights to [0,100]', () => {
    // wE=150 → clamped to 100; with wB=0 + wP=0 + wE=100, blended = exposure
    expect(deriveComponentTotal('8', '2', '10', '0', '0', '150', '20')).toBeCloseTo(12.5);
    // wB=-50 → clamped to 0; remaining (0 pareto, 100 exposure) → blended = exposure
    expect(deriveComponentTotal('8', '2', '10', '-50', '0', '100', '0')).toBe(10);
  });

  it('clamps loading to [0,99]', () => {
    // loading=150 → clamped to 99, denominator tiny → blown up
    const r = deriveComponentTotal('10', '0', '10', '50', '0', '50', '150');
    expect(r).toBeGreaterThan(999);
    // loading=-5 → clamped to 0
    expect(deriveComponentTotal('10', '0', '10', '50', '0', '50', '-5')).toBe(10);
  });

  it('returns 0 when all weights are zero (no method selected)', () => {
    expect(deriveComponentTotal('8', '2', '10', '0', '0', '0', '20')).toBe(0);
  });

  it('treats empty strings as zero', () => {
    expect(deriveComponentTotal('', '', '', '', '', '', '')).toBe(0);
  });
});
