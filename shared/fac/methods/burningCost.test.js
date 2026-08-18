import { describe, it, expect } from 'vitest';
import { restateLoss, burningCostLossCost, DEFAULT_DEVELOPMENT_FACTOR } from './burningCost.js';

const AS_OF = 2026;
const OPTS = { asOfYear: AS_OF, trend: 0.05, developmentFactor: 1.2, attachment: 0, limit: Infinity };

describe('restateLoss — index, develop, as-if, layer', () => {
  it('trends a closed loss to current values', () => {
    const r = restateLoss(
      { loss_year: 2021, fgu_paid: 100_000, fgu_outstanding: 0, is_open: false }, OPTS,
    );
    expect(r.years).toBe(5);
    expect(r.indexed).toBeCloseTo(100_000 * 1.05 ** 5, 6);
    expect(r.developed).toBeCloseTo(r.indexed, 12);   // closed: no development
    expect(r.layer).toBeCloseTo(r.indexed, 12);
  });

  it('develops an open claim and leaves a closed one alone', () => {
    const open = restateLoss({ loss_year: 2026, fgu_paid: 0, fgu_outstanding: 100_000, is_open: true }, OPTS);
    const closed = restateLoss({ loss_year: 2026, fgu_paid: 100_000, fgu_outstanding: 0, is_open: false }, OPTS);
    expect(open.developed).toBeCloseTo(120_000, 6);
    expect(closed.developed).toBeCloseTo(100_000, 6);
  });

  it('lets an explicit restatement override the derived chain', () => {
    // An underwriter who has restated a claim knows something the trend
    // factor does not, so the override wins outright.
    const r = restateLoss({
      loss_year: 2019, fgu_paid: 100_000, is_open: true,
      indexed_incurred: 250_000, development_factor: 1, as_if_incurred: 300_000,
    }, OPTS);
    expect(r.indexed).toBe(250_000);
    expect(r.developed).toBe(250_000);
    expect(r.asIf).toBe(300_000);
    expect(r.layer).toBe(300_000);
  });

  it('applies the structure being quoted', () => {
    const r = restateLoss(
      { loss_year: 2026, fgu_paid: 900_000, is_open: false },
      { ...OPTS, attachment: 500_000, limit: 200_000 },
    );
    expect(r.asIf).toBeCloseTo(900_000, 6);
    expect(r.layer).toBeCloseTo(200_000, 6);          // capped by the limit
  });

  it('drops a loss below the attachment out of the layer but keeps it counted', () => {
    const r = restateLoss(
      { loss_year: 2026, fgu_paid: 100_000, is_open: false },
      { ...OPTS, attachment: 500_000, limit: 1_000_000 },
    );
    expect(r.included).toBe(true);
    expect(r.layer).toBe(0);
  });

  it('excludes a flagged loss and says why', () => {
    const r = restateLoss(
      { loss_year: 2022, fgu_paid: 5_000_000, exclude_from_rating: true, exclusion_reason: 'One-off, plant since sold' },
      OPTS,
    );
    expect(r.included).toBe(false);
    expect(r.reason).toMatch(/plant since sold/);
    expect(r.layer).toBe(0);
  });

  it('excludes a nil or undated loss without blowing up', () => {
    expect(restateLoss({ loss_year: 2022, fgu_paid: 0 }, OPTS).included).toBe(false);
    expect(restateLoss({ fgu_paid: 1000 }, OPTS).included).toBe(false);
  });
});

describe('burningCostLossCost', () => {
  const BASIS = [2022, 2023, 2024, 2025, 2026].map((y) => ({ loss_year: y, exposure_base: 100_000_000 }));

  it('divides by every exposure year, including the ones with no claims', () => {
    // One 500k loss in 2026, five exposure years at 100m.
    const out = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_paid: 500_000, is_open: false }],
      basis: BASIS,
      severityTrendPct: 0,
      asOfYear: 2026,
    });
    expect(out.available).toBe(true);
    expect(out.years).toBe(5);
    expect(out.lossCost).toBeCloseTo(100_000, 6);           // 500k over 5 years
    expect(out.ratePm).toBeCloseTo(1.0, 9);                 // 100k / 100m × 1000
    expect(out.claimCount).toBe(1);
  });

  it('would double the rate if the zero-loss years were dropped — they are not', () => {
    const full = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_paid: 500_000, is_open: false }],
      basis: BASIS, severityTrendPct: 0, asOfYear: 2026,
    });
    const short = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_paid: 500_000, is_open: false }],
      basis: BASIS.slice(-2), severityTrendPct: 0, asOfYear: 2026,
    });
    expect(short.ratePm).toBeCloseTo(full.ratePm * 2.5, 9);
  });

  it('indexes older losses up', () => {
    const flat = burningCostLossCost({
      losses: [{ loss_year: 2022, fgu_paid: 500_000, is_open: false }],
      basis: BASIS, severityTrendPct: 0, asOfYear: 2026,
    });
    const trended = burningCostLossCost({
      losses: [{ loss_year: 2022, fgu_paid: 500_000, is_open: false }],
      basis: BASIS, severityTrendPct: 6, asOfYear: 2026,
    });
    expect(trended.ratePm).toBeCloseTo(flat.ratePm * 1.06 ** 4, 9);
  });

  it('prices to the layer being quoted', () => {
    const losses = [
      { loss_year: 2025, fgu_paid: 200_000, is_open: false },   // under the attachment
      { loss_year: 2026, fgu_paid: 900_000, is_open: false },   // 400k into the layer
    ];
    const ground = burningCostLossCost({ losses, basis: BASIS, severityTrendPct: 0, asOfYear: 2026 });
    const excess = burningCostLossCost({
      losses, basis: BASIS, severityTrendPct: 0, asOfYear: 2026,
      attachment: 500_000, limit: 1_000_000,
    });
    expect(ground.lossCost).toBeCloseTo(1_100_000 / 5, 6);
    expect(excess.lossCost).toBeCloseTo(400_000 / 5, 6);
    expect(excess.claimCount).toBe(1);                       // only one reaches the layer
  });

  it('reports an on-levelled loss ratio when premiums were recorded', () => {
    const basis = [
      { loss_year: 2025, exposure_base: 100_000_000, premium: 100_000, rate_change_pct: 0 },
      { loss_year: 2026, exposure_base: 100_000_000, premium: 110_000, rate_change_pct: 10 },
    ];
    const out = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_paid: 100_000, is_open: false }],
      basis, severityTrendPct: 0, asOfYear: 2026,
    });
    // 2025's premium is brought up to the 2026 rate level (×1.10), so the
    // denominator is 110,000 + 110,000.
    expect(out.diagnostics.on_levelled_loss_ratio).toBeCloseTo(100_000 / 220_000, 9);
  });

  it('falls back to today\'s exposure when no history was entered, and says so', () => {
    const out = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_paid: 500_000, is_open: false }],
      basis: [], severityTrendPct: 0, asOfYear: 2026,
      fallbackExposure: 100_000_000, fallbackYears: 5,
    });
    expect(out.available).toBe(true);
    expect(out.diagnostics.denominator_source).toBe('CURRENT_EXPOSURE');
    expect(out.diagnostics.warnings.join(' ')).toMatch(/historic sums insured/);
    expect(out.ratePm).toBeCloseTo(1.0, 9);
  });

  it('is unavailable — not zero — with no denominator at all', () => {
    const out = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_paid: 500_000 }], basis: [],
    });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/exposure years/i);
  });

  it('returns a nil burn rate for a clean record rather than refusing to answer', () => {
    const out = burningCostLossCost({ losses: [], basis: BASIS, asOfYear: 2026 });
    expect(out.available).toBe(true);
    expect(out.lossCost).toBe(0);
    expect(out.ratePm).toBe(0);
    expect(out.claimCount).toBe(0);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/nil/i);
  });

  it('applies the default development factor to open claims', () => {
    const out = burningCostLossCost({
      losses: [{ loss_year: 2026, fgu_outstanding: 100_000, is_open: true }],
      basis: BASIS, severityTrendPct: 0, asOfYear: 2026,
    });
    expect(out.diagnostics.total_as_if).toBeCloseTo(100_000 * DEFAULT_DEVELOPMENT_FACTOR, 6);
  });

  it('counts what it excluded, so the omission is visible', () => {
    const out = burningCostLossCost({
      losses: [
        { loss_year: 2026, fgu_paid: 100_000, is_open: false },
        { loss_year: 2024, fgu_paid: 9_000_000, exclude_from_rating: true, exclusion_reason: 'Plant sold' },
      ],
      basis: BASIS, severityTrendPct: 0, asOfYear: 2026,
    });
    expect(out.diagnostics.claims_excluded).toBe(1);
    expect(out.diagnostics.total_as_if).toBeCloseTo(100_000, 6);
  });
});
