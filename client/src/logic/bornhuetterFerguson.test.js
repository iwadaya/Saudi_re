// bornhuetterFerguson.test.js
//
// F100: calculateBFPremium's documented default for a missing achieved-premium
// ratio is 100% ("the achieved-premium ratio (default 100 %)"), but the scalar
// branch used `Number(percentAchieveds) || 0` — so omitting the argument (or
// passing null/undefined) collapsed the a priori to 0 and the "ultimate"
// silently degenerated to the undeveloped latest, while a missing ARRAY
// element correctly defaulted to 1. Both shapes now default missing /
// non-numeric to 1, and both honour an explicit finite value — including 0.

import { describe, expect, it } from 'vitest';
import { calculateBF, calculateBFPremium } from './bornhuetterFerguson.js';

// Hand-derived fixture: latest 1600, CDF 2.268, EPI 4000.
//   percentEarned     = 1 / 2.268 = 0.4409171075837742
//   percentUnachieved = 1 − 0.4409171075837742 = 0.5590828924162258
// With pa = 1 (the documented default):
//   aPriori   = 4000 × 1 = 4000
//   bfUnearned = 4000 × 0.5590828924162258 = 2236.331569664903
//   ultimate   = 1600 + 2236.331569664903 = 3836.331569664903
const PROJ = [{ year: 2023, latest: 1600, cdf: 2.268 }];
const EPIS = [4000];
const ULT_PA1 = 3836.331569664903;

describe('calculateBFPremium — achieved-premium ratio defaults (F100)', () => {
  it('omitted / undefined scalar defaults to 100%, not 0', () => {
    for (const arg of [undefined, null]) {
      const [r] = calculateBFPremium(PROJ, EPIS, arg);
      expect(r.percentAchieved).toBe(1);
      expect(r.ultimate).toBeCloseTo(ULT_PA1, 9);
    }
    // Two-argument call (the shape any new caller would naturally write)
    const [r] = calculateBFPremium(PROJ, EPIS);
    expect(r.ultimate).toBeCloseTo(ULT_PA1, 9);
  });

  it('scalar and array-with-missing-element agree (the pre-fix inconsistency)', () => {
    const [scalar] = calculateBFPremium(PROJ, EPIS, undefined);
    const [arrayMissing] = calculateBFPremium(PROJ, EPIS, [undefined]);
    expect(scalar.percentAchieved).toBe(arrayMissing.percentAchieved);
    expect(scalar.ultimate).toBeCloseTo(arrayMissing.ultimate, 9);
    // Pre-fix: scalar gave percentAchieved 0 → ultimate 1600 (no premium
    // development at all); array gave 1 → 3836.33.
    expect(scalar.ultimate).toBeCloseTo(ULT_PA1, 9);
  });

  it('a non-numeric ratio falls back to the documented 100% in both shapes', () => {
    const [scalar] = calculateBFPremium(PROJ, EPIS, 'not-a-number');
    const [arrayEl] = calculateBFPremium(PROJ, EPIS, ['not-a-number']);
    expect(scalar.percentAchieved).toBe(1);
    expect(arrayEl.percentAchieved).toBe(1);
  });

  it('an explicit finite ratio — including 0 — is honoured in both shapes', () => {
    // pa = 0.5: bfUnearned = 2000 × 0.5590828924162258 = 1118.1657848324516
    //           ultimate   = 1600 + 1118.1657848324516 = 2718.1657848324515
    const [half] = calculateBFPremium(PROJ, EPIS, 0.5);
    expect(half.percentAchieved).toBe(0.5);
    expect(half.ultimate).toBeCloseTo(2718.1657848324515, 9);
    const [halfArr] = calculateBFPremium(PROJ, EPIS, [0.5]);
    expect(halfArr.ultimate).toBeCloseTo(2718.1657848324515, 9);

    // Explicit 0 means "no a priori volume" — NOT re-defaulted to 1.
    const [zeroScalar] = calculateBFPremium(PROJ, EPIS, 0);
    const [zeroArr] = calculateBFPremium(PROJ, EPIS, [0]);
    expect(zeroScalar.percentAchieved).toBe(0);
    expect(zeroArr.percentAchieved).toBe(0);
    expect(zeroScalar.ultimate).toBe(1600); // latest only, by explicit choice
  });

  it('returns [] for a missing projection array', () => {
    expect(calculateBFPremium(null, EPIS, 1)).toEqual([]);
    expect(calculateBFPremium(undefined, EPIS, 1)).toEqual([]);
  });
});

describe('calculateBF — loss BF sanity (pins the existing behaviour)', () => {
  it('BF ultimate = latest + premium × IELR × (1 − 1/CDF), hand-derived', () => {
    // premium 4000, ielr 0.65 → a priori 2600; CDF 2.0 → % unreported 0.5;
    // expected IBNR = 1300; latest 1600 → ultimate 2900; LR 2900/4000 = 0.725.
    const [r] = calculateBF([{ year: 2023, latest: 1600, cdf: 2.0 }], [4000], 0.65);
    expect(r.aPrioriUltimate).toBeCloseTo(2600, 9);
    expect(r.expectedIbnr).toBeCloseTo(1300, 9);
    expect(r.ultimate).toBeCloseTo(2900, 9);
    expect(r.lossRatio).toBeCloseTo(0.725, 9);
  });
});
