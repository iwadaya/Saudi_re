import { describe, it, expect } from 'vitest';
import { frequencySeverity, freqSeverityLossCost } from './freqSeverity.js';

// A 500-vehicle fleet, five years, claim counts declared on the basis.
const BASIS = [
  { loss_year: 2021, exposure_base: 400, claim_count: 40 },
  { loss_year: 2022, exposure_base: 450, claim_count: 47 },
  { loss_year: 2023, exposure_base: 480, claim_count: 50 },
  { loss_year: 2024, exposure_base: 500, claim_count: 52 },
  { loss_year: 2025, exposure_base: 520, claim_count: 55 },
];
const TOTAL_UNITS = 2350;
const TOTAL_DECLARED = 244;

// The large-loss listing — only the claims worth listing, which is the trap.
const LOSSES = [
  { loss_year: 2023, fgu_incurred: 100_000 },
  { loss_year: 2024, fgu_incurred: 200_000 },
  { loss_year: 2025, fgu_incurred: 300_000 },
];

describe('frequencySeverity', () => {
  it('divides the declared claim count by the exposure years', () => {
    const r = frequencySeverity({ losses: LOSSES, basis: BASIS, asOfYear: 2026 });
    expect(r.available).toBe(true);
    expect(r.frequency).toBeCloseTo(TOTAL_DECLARED / TOTAL_UNITS, 12);
    expect(r.diagnostics.count_basis).toBe('DECLARED');
  });

  it('takes severity from the listing, not from the declared count', () => {
    // This is the whole point of splitting the two: dividing the listed
    // amounts by 244 declared claims would understate severity ~80-fold.
    const r = frequencySeverity({ losses: LOSSES, basis: BASIS, asOfYear: 2026 });
    expect(r.severity).toBeCloseTo(600_000 / 3, -1);
    expect(r.diagnostics.listing_count).toBe(3);
  });

  it('says plainly that the two are measured on different populations', () => {
    const r = frequencySeverity({ losses: LOSSES, basis: BASIS, asOfYear: 2026 });
    expect(r.diagnostics.warnings.join(' ')).toMatch(/different populations/i);
  });

  it('falls back to the listing count when the basis declares none', () => {
    const basis = BASIS.map((b) => ({
      loss_year: b.loss_year, exposure_base: b.exposure_base,
    }));
    const r = frequencySeverity({ losses: LOSSES, basis, asOfYear: 2026 });
    expect(r.diagnostics.count_basis).toBe('LOSS_LISTING');
    expect(r.frequency).toBeCloseTo(3 / TOTAL_UNITS, 12);
  });

  it('trends severity from each loss year to the policy year', () => {
    const flat = frequencySeverity({ losses: LOSSES, basis: BASIS, asOfYear: 2026 });
    const trended = frequencySeverity({
      losses: LOSSES, basis: BASIS, asOfYear: 2026, severityTrendPct: 10,
    });
    // 10 means 10%/yr: 100k×1.1³ + 200k×1.1² + 300k×1.1, over three claims.
    const expected = (100_000 * 1.1 ** 3 + 200_000 * 1.1 ** 2 + 300_000 * 1.1) / 3;
    expect(trended.severity).toBeCloseTo(expected, 4);
    expect(trended.severity).toBeGreaterThan(flat.severity);
  });

  it('takes the trend as a whole percent — the same unit burning cost takes (F41)', () => {
    // risk.severity_trend_pct holds 6 for 6%/yr and index.js passes it to
    // both experience methods verbatim. Under the old fraction reading, 6
    // trended a 2023 claim ×(1+6)³ = ×343 — three hundred times the money.
    const r = frequencySeverity({
      losses: [{ loss_year: 2023, fgu_incurred: 100_000 }],
      basis: BASIS, asOfYear: 2026, severityTrendPct: 6,
    });
    // 100,000 × 1.06³ = 119,101.60 — hand-derived.
    expect(r.severity).toBeCloseTo(119_101.60, 2);
    expect(r.diagnostics.severity_trend_pct).toBe(6);
  });

  it('applies the same whole-percent trend inside a layer split (F41)', () => {
    const r = freqSeverityLossCost({
      losses: [{ loss_year: 2023, fgu_incurred: 1_000_000 }],
      basis: BASIS, exposureUnits: 500, asOfYear: 2026, severityTrendPct: 6,
      attachment: 1_000_000, limit: 5_000_000,
    });
    // 1,000,000 × 1.06³ = 1,191,016; layer share above 1m = 191,016.
    expect(r.diagnostics.severity).toBeCloseTo(191_016, 0);
  });

  it('prefers the restated amount the experience screen produced', () => {
    const r = frequencySeverity({
      losses: [{ loss_year: 2025, fgu_incurred: 100_000, as_if_incurred: 250_000 }],
      basis: BASIS, asOfYear: 2026,
    });
    expect(r.severity).toBeCloseTo(250_000, 6);
  });

  it('leaves excluded claims out', () => {
    const r = frequencySeverity({
      losses: [...LOSSES, { loss_year: 2025, fgu_incurred: 9_000_000, exclude_from_rating: true }],
      basis: BASIS, asOfYear: 2026,
    });
    expect(r.diagnostics.listing_count).toBe(3);
  });

  it('treats a clean record as evidence, not as missing data', () => {
    const clean = BASIS.map((b) => ({ ...b, claim_count: 0 }));
    const r = frequencySeverity({ losses: [], basis: clean, asOfYear: 2026 });
    expect(r.available).toBe(true);
    expect(r.frequency).toBe(0);
    expect(r.claimCount).toBe(0);
    expect(r.diagnostics.note).toMatch(/clean record is evidence/i);
  });

  it('reports unavailable, with a reason, when there is no exposure history', () => {
    const r = frequencySeverity({ losses: LOSSES, basis: [], asOfYear: 2026 });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/units at risk/i);
  });

  it('refuses to divide by zero units', () => {
    const r = frequencySeverity({
      losses: LOSSES, basis: [{ loss_year: 2025, exposure_base: 0 }], asOfYear: 2026,
    });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/zero vehicle-years/i);
  });

  it('warns when the average rests on very few claims', () => {
    const r = frequencySeverity({
      losses: [{ loss_year: 2025, fgu_incurred: 500_000 }], basis: BASIS, asOfYear: 2026,
    });
    expect(r.diagnostics.warnings.join(' ')).toMatch(/unstable at this volume/i);
  });
});

describe('freqSeverityLossCost', () => {
  it('prices the units being covered, not the units in the experience', () => {
    const r = freqSeverityLossCost({
      losses: LOSSES, basis: BASIS, exposureUnits: 800, asOfYear: 2026,
    });
    // A fleet that grew to 800 rates on its old frequency and its new count.
    const freq = TOTAL_DECLARED / TOTAL_UNITS;
    expect(r.lossCost).toBeCloseTo(freq * (600_000 / 3) * 800, 4);
    expect(r.diagnostics.exposure_units).toBe(800);
  });

  it('expresses a rate per mille of whatever base the family rates on', () => {
    const r = freqSeverityLossCost({
      losses: LOSSES, basis: BASIS, exposureUnits: 500, asOfYear: 2026,
      premiumBase: 50_000_000,
    });
    expect(r.ratePm).toBeCloseTo((r.lossCost / 50_000_000) * 1000, 9);
  });

  it('has no rate when there is no base to express one against', () => {
    const r = freqSeverityLossCost({
      losses: LOSSES, basis: BASIS, exposureUnits: 500, asOfYear: 2026,
    });
    expect(r.ratePm).toBeNull();
    expect(r.lossCost).toBeGreaterThan(0);
  });

  it('applies a layer per claim, never to the average', () => {
    const r = freqSeverityLossCost({
      losses: LOSSES, basis: BASIS, exposureUnits: 500, asOfYear: 2026,
      attachment: 150_000, limit: 100_000,
    });
    // Per claim: 100k→0, 200k→50k, 300k→100k. Average 50k, not
    // (200k − 150k) capped, which is what averaging first would give.
    expect(r.diagnostics.severity).toBeCloseTo(150_000 / 3, 6);
    expect(r.diagnostics.ground_up_severity).toBeCloseTo(200_000, 6);
  });

  it('flags an excess layer no claim in the record has reached', () => {
    const r = freqSeverityLossCost({
      losses: LOSSES, basis: BASIS, exposureUnits: 500, asOfYear: 2026,
      attachment: 1_000_000, limit: 1_000_000,
    });
    expect(r.lossCost).toBe(0);
    expect(r.diagnostics.layer_unpierced).toBe(true);
    expect(r.diagnostics.warnings.join(' ')).toMatch(/needs a severity curve/i);
  });

  it('reports unavailable when there are no units to price', () => {
    const r = freqSeverityLossCost({ losses: LOSSES, basis: BASIS, exposureUnits: 0 });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/exposure units/i);
  });

  it('passes the experience shortfall through rather than pricing anyway', () => {
    const r = freqSeverityLossCost({ losses: LOSSES, basis: [], exposureUnits: 500 });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/units at risk/i);
  });
});
