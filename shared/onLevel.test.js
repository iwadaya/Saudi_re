// Tests for on-level premium adjustment math.
//
// Convention check: r_y is the rate change applied IN year y; the
// adjusted premium for year y multiplies every r_i for i > y.

import { describe, it, expect } from 'vitest';
import { computeOnLevelFactors, applyOnLevelFactors } from './onLevel.js';

describe('computeOnLevelFactors', () => {
  it('latest year always has factor 1.0 (no adjustment)', () => {
    const factors = computeOnLevelFactors([2020, 2021, 2022, 2023], { 2022: 5, 2023: 3 });
    expect(factors.get(2023)).toBe(1);
  });

  it('matches the textbook chain Π over i > y of (1 + r_i / 100)', () => {
    // r_2022 = +5%, r_2023 = -3%, r_2024 = +2%
    // 2021 factor = (1+0.05)(1-0.03)(1+0.02) = 1.05·0.97·1.02 = 1.038870
    // 2022 factor = (1-0.03)(1+0.02) = 0.97·1.02 = 0.9894
    // 2023 factor = (1+0.02) = 1.02
    // 2024 factor = 1.0
    const factors = computeOnLevelFactors(
      [2021, 2022, 2023, 2024],
      { 2022: 5, 2023: -3, 2024: 2 },
    );
    expect(factors.get(2024)).toBeCloseTo(1.0, 10);
    expect(factors.get(2023)).toBeCloseTo(1.02, 10);
    expect(factors.get(2022)).toBeCloseTo(1.02 * 0.97, 10);
    expect(factors.get(2021)).toBeCloseTo(1.02 * 0.97 * 1.05, 10);
  });

  it('missing / NaN rate changes are treated as 0%', () => {
    // Only 2023 has a +5% rate change; the rest are missing (treated as 0%).
    const factors = computeOnLevelFactors([2020, 2021, 2022, 2023], { 2023: 5 });
    expect(factors.get(2023)).toBe(1);
    expect(factors.get(2022)).toBeCloseTo(1.05, 10);
    expect(factors.get(2021)).toBeCloseTo(1.05, 10);
    expect(factors.get(2020)).toBeCloseTo(1.05, 10);
  });

  it('accepts both Map and plain-object shapes for rateByYear', () => {
    const obj = computeOnLevelFactors([2022, 2023], { 2023: 5 });
    const map = computeOnLevelFactors([2022, 2023], new Map([[2023, 5]]));
    expect(map.get(2022)).toBeCloseTo(obj.get(2022), 10);
    expect(map.get(2023)).toBeCloseTo(obj.get(2023), 10);
  });

  it('handles unsorted year input', () => {
    // Should give the same answer regardless of input order.
    const a = computeOnLevelFactors([2021, 2022, 2023], { 2022: 10, 2023: 5 });
    const b = computeOnLevelFactors([2023, 2021, 2022], { 2022: 10, 2023: 5 });
    expect(a.get(2021)).toBeCloseTo(b.get(2021), 10);
    expect(a.get(2022)).toBeCloseTo(b.get(2022), 10);
  });

  it('empty / invalid years → empty map', () => {
    expect(computeOnLevelFactors([], {}).size).toBe(0);
    expect(computeOnLevelFactors([NaN, 'foo'], {}).size).toBe(0);
  });

  it('all-zero rate changes → all factors are 1', () => {
    const factors = computeOnLevelFactors([2020, 2021, 2022], {});
    expect(factors.get(2020)).toBe(1);
    expect(factors.get(2021)).toBe(1);
    expect(factors.get(2022)).toBe(1);
  });
});

describe('applyOnLevelFactors', () => {
  it('multiplies premium by its factor; drops years without premium', () => {
    const factors = new Map([[2022, 1.08], [2023, 1.02], [2024, 1.0]]);
    const premiums = { 2022: 8_000_000, 2024: 11_000_000 };
    const out = applyOnLevelFactors(premiums, factors);
    expect(out.get(2022)).toBeCloseTo(8_640_000, 4);
    expect(out.has(2023)).toBe(false); // no premium for 2023
    expect(out.get(2024)).toBeCloseTo(11_000_000, 4);
  });

  it('accepts a Map input for premiums', () => {
    const factors = new Map([[2023, 1.05]]);
    const premiums = new Map([[2023, 10_000_000]]);
    const out = applyOnLevelFactors(premiums, factors);
    expect(out.get(2023)).toBeCloseTo(10_500_000, 4);
  });
});
