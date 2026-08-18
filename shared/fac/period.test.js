import { describe, it, expect } from 'vitest';
import {
  projectPeriodFactor, earnedFraction, elapsedFraction, earnedPremium,
  periodMonths, EARNING_PATTERNS,
} from './period.js';

describe('projectPeriodFactor', () => {
  it('loads a project longer than the baseline', () => {
    // 24 months at 3%/month beyond a 12-month baseline → 1 + 0.03 × 12 = 1.36
    const { factor, applied } = projectPeriodFactor({ months: 24, perMonth: 0.03 });
    expect(factor).toBeCloseTo(1.36, 12);
    expect(applied).toBe(true);
  });

  it('is exactly 1 at the baseline', () => {
    expect(projectPeriodFactor({ months: 12, perMonth: 0.03 }).factor).toBe(1);
  });

  it('discounts a project shorter than the baseline, symmetrically', () => {
    expect(projectPeriodFactor({ months: 6, perMonth: 0.03 }).factor).toBeCloseTo(0.82, 12);
  });

  it('never lets a very short project drive the rate to zero', () => {
    expect(projectPeriodFactor({ months: 1, perMonth: 0.20 }).factor).toBe(0.05);
  });

  it('does not invent a loading when none is loaded', () => {
    const { factor, applied, basis } = projectPeriodFactor({ months: 36, perMonth: null });
    expect(factor).toBe(1);
    expect(applied).toBe(false);
    expect(basis).toBe('NO_PERIOD_LOADING_LOADED');
  });

  it('reports a missing period rather than assuming twelve months', () => {
    expect(projectPeriodFactor({ months: null, perMonth: 0.03 }).basis).toBe('NO_PERIOD');
  });

  it('honours a non-standard baseline', () => {
    expect(projectPeriodFactor({ months: 30, perMonth: 0.02, baselineMonths: 24 }).factor)
      .toBeCloseTo(1.12, 12);
  });
});

describe('earnedFraction', () => {
  it('earns straight-line premium in proportion to time', () => {
    expect(earnedFraction(0.25)).toBe(0.25);
    expect(earnedFraction(0.5)).toBe(0.5);
  });

  it('earns an S-curve slowly at first', () => {
    // 3t² − 2t³ at t = 0.25 → 0.15625, well under the straight line.
    expect(earnedFraction(0.25, 'S_CURVE')).toBeCloseTo(0.15625, 12);
    expect(earnedFraction(0.25, 'S_CURVE')).toBeLessThan(0.25);
  });

  it('crosses the straight line at the midpoint', () => {
    expect(earnedFraction(0.5, 'S_CURVE')).toBeCloseTo(0.5, 12);
  });

  it('earns an S-curve faster than straight-line in the second half', () => {
    expect(earnedFraction(0.75, 'S_CURVE')).toBeGreaterThan(0.75);
  });

  it('is 0 at inception and 1 at expiry under either pattern', () => {
    for (const p of EARNING_PATTERNS) {
      expect(earnedFraction(0, p)).toBe(0);
      expect(earnedFraction(1, p)).toBe(1);
    }
  });

  it('clamps outside the period rather than extrapolating', () => {
    expect(earnedFraction(-0.5, 'S_CURVE')).toBe(0);
    expect(earnedFraction(1.5, 'S_CURVE')).toBe(1);
  });
});

describe('elapsedFraction', () => {
  it('places a date inside the period', () => {
    const f = elapsedFraction({ from: '2026-01-01', to: '2027-01-01', asOf: '2026-07-02' });
    expect(f).toBeCloseTo(0.5, 2);
  });

  it('clamps before inception and after expiry', () => {
    expect(elapsedFraction({ from: '2026-01-01', to: '2027-01-01', asOf: '2025-06-01' })).toBe(0);
    expect(elapsedFraction({ from: '2026-01-01', to: '2027-01-01', asOf: '2028-06-01' })).toBe(1);
  });

  it('returns null rather than a guess when a date is missing or backwards', () => {
    expect(elapsedFraction({ from: null, to: '2027-01-01', asOf: '2026-06-01' })).toBeNull();
    expect(elapsedFraction({ from: '2027-01-01', to: '2026-01-01', asOf: '2026-06-01' })).toBeNull();
    expect(elapsedFraction({ from: 'not a date', to: '2027-01-01', asOf: '2026-06-01' })).toBeNull();
  });
});

describe('earnedPremium', () => {
  it('splits a premium into earned and unearned', () => {
    const r = earnedPremium({
      premium: 1_000_000, from: '2026-01-01', to: '2027-01-01', asOf: '2026-07-02',
    });
    expect(r.earned + r.unearned).toBeCloseTo(1_000_000, 6);
    expect(r.earned).toBeCloseTo(500_000, -4);
  });

  it('leaves a three-year project mostly unearned in its first year on an S-curve', () => {
    const straight = earnedPremium({
      premium: 3_000_000, from: '2026-01-01', to: '2029-01-01', asOf: '2027-01-01',
      pattern: 'STRAIGHT_LINE',
    });
    const sCurve = earnedPremium({
      premium: 3_000_000, from: '2026-01-01', to: '2029-01-01', asOf: '2027-01-01',
      pattern: 'S_CURVE',
    });
    // This is the whole point: straight-line overstates year-one earned
    // premium on a construction risk, and understates the unearned reserve.
    expect(sCurve.earned).toBeLessThan(straight.earned);
    expect(sCurve.unearned).toBeGreaterThan(straight.unearned);
  });

  it('returns nulls rather than zeros when the dates cannot place it', () => {
    const r = earnedPremium({ premium: 1_000_000, from: null, to: null, asOf: null });
    expect(r.earned).toBeNull();
    expect(r.unearned).toBeNull();
  });
});

describe('periodMonths', () => {
  it('measures the period from the dates when both are set', () => {
    expect(periodMonths({ inception_date: '2026-01-01', expiry_date: '2029-01-01' })).toBe(36);
  });

  it('does not round a part month up', () => {
    expect(periodMonths({ inception_date: '2026-01-15', expiry_date: '2026-07-10' })).toBe(5);
  });

  it('falls back to the stated policy period', () => {
    expect(periodMonths({ policy_period_months: 30 })).toBe(30);
  });

  it('prefers the dates over a stale stated period', () => {
    expect(periodMonths({
      inception_date: '2026-01-01', expiry_date: '2028-01-01', policy_period_months: 12,
    })).toBe(24);
  });

  it('returns null when it knows neither', () => {
    expect(periodMonths({})).toBeNull();
    expect(periodMonths(null)).toBeNull();
  });
});
