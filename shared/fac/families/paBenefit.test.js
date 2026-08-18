import { describe, it, expect } from 'vitest';
import {
  readExposure, selectPaRate, paLossCost, computeCandidates, paBenefit, COVER_BASES,
} from './paBenefit.js';

const CLASS_1 = {
  occupational_class: '1', cover_basis: '24_HOUR', territory: 'WORLDWIDE',
  rate_per_unit: 0.0012, source: 'test',
};
const CLASS_4 = { ...CLASS_1, occupational_class: '4', rate_per_unit: 0.0065 };
const CLASS_1_OCC = { ...CLASS_1, cover_basis: 'OCCUPATIONAL', rate_per_unit: 0.0006 };
const CLASS_1_KSA = { ...CLASS_1, territory: 'KSA', rate_per_unit: 0.0014 };

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'PA_BENEFIT',
  exposure_base: 400,
  exposure_detail: { occupational_class: '1', benefit_units: 250_000, ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  paBaseRates: [CLASS_1, CLASS_4, CLASS_1_OCC, CLASS_1_KSA],
  ...o,
});

describe('readExposure', () => {
  it('treats a single-class scheme as one group', () => {
    const e = readExposure(section());
    expect(e.classes).toHaveLength(1);
    expect(e.totalHeadcount).toBe(400);
    expect(e.totalBenefit).toBe(400 * 250_000);
  });

  it('reads a class schedule and totals headcount and benefit', () => {
    const e = readExposure(section({
      classes: [
        { occupational_class: '1', headcount: 300, benefit_units: 250_000 },
        { occupational_class: '4', headcount: 100, benefit_units: 150_000 },
      ],
    }));
    expect(e.totalHeadcount).toBe(400);
    expect(e.totalBenefit).toBe(300 * 250_000 + 100 * 150_000);
  });

  it('defaults the cover basis to 24-hour and reads the one-event exposure', () => {
    expect(readExposure(section()).coverBasis).toBe('24_HOUR');
    expect(readExposure(section({ max_one_event_headcount: 45 })).maxOneEventHeadcount).toBe(45);
  });

  it('knows the two cover bases', () => {
    expect(COVER_BASES).toEqual(['24_HOUR', 'OCCUPATIONAL']);
  });
});

describe('selectPaRate', () => {
  const pool = [CLASS_1, CLASS_4, CLASS_1_OCC, CLASS_1_KSA];

  it('keys on the occupational class', () => {
    expect(selectPaRate(pool, {
      occupationalClass: '4', coverBasis: '24_HOUR', territory: 'WORLDWIDE',
    }).rate).toBe(CLASS_4);
  });

  it('never substitutes one cover basis for the other', () => {
    // 24-hour cover includes the commute, the football match and the holiday.
    // Occupational-only does not. That is a different price, not a fallback.
    expect(selectPaRate(pool, {
      occupationalClass: '4', coverBasis: 'OCCUPATIONAL', territory: 'WORLDWIDE',
    }).rate).toBeNull();
  });

  it('does relax the territory, and says so', () => {
    const r = selectPaRate(pool, {
      occupationalClass: '1', coverBasis: '24_HOUR', territory: 'EGYPT',
    });
    expect(r.rate).toBe(CLASS_1);
    expect(r.fellBackToWorldwide).toBe(true);
  });
});

describe('paLossCost', () => {
  const price = (detail = {}, overrides = {}, r = rates()) => paLossCost({
    exposure: readExposure(section(detail, overrides)), rates: r,
  });

  it('costs benefit units per member at the class rate', () => {
    const out = price();
    expect(out.available).toBe(true);
    expect(out.lossCost).toBeCloseTo(400 * 250_000 * 0.0012, 6);
  });

  it('rates each occupational class on its own rate', () => {
    const out = price({
      classes: [
        { occupational_class: '1', headcount: 300, benefit_units: 250_000 },
        { occupational_class: '4', headcount: 100, benefit_units: 150_000 },
      ],
    });
    expect(out.lossCost).toBeCloseTo(
      300 * 250_000 * 0.0012 + 100 * 150_000 * 0.0065, 6,
    );
    expect(out.diagnostics.classes).toHaveLength(2);
  });

  it('prices occupational-only cover at the occupational rate', () => {
    const allHours = price();
    const occOnly = price({ cover_basis: 'OCCUPATIONAL' });
    expect(occOnly.lossCost).toBeCloseTo(allHours.lossCost * 0.5, 6);
  });

  it('refuses a cover basis it does not rate', () => {
    const out = price({ cover_basis: 'TRAVEL_ONLY' });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/not variants of one/i);
  });

  it('carries the one-event exposure for the capacity check', () => {
    const out = price({ max_one_event_headcount: 45 });
    expect(out.diagnostics.max_one_event_headcount).toBe(45);
    expect(out.diagnostics.one_event_benefit).toBeCloseTo(45 * 250_000, 6);
  });

  it('says so when no one-event exposure is stated', () => {
    expect(price().diagnostics.warnings.join(' ')).toMatch(/accumulation is, when a group travels/i);
  });

  it('prices what it can and reports the members it could not', () => {
    const out = price({
      classes: [
        { occupational_class: '1', headcount: 300, benefit_units: 250_000 },
        { occupational_class: '9', headcount: 50, benefit_units: 100_000 },
      ],
    });
    expect(out.available).toBe(true);
    expect(out.diagnostics.rated_headcount).toBe(300);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/50 members/);
  });

  it('expresses a rate per mille of the total benefit at risk', () => {
    const out = price();
    expect(out.ratePm).toBeCloseTo((out.lossCost / (400 * 250_000)) * 1000, 9);
  });

  it('reports unavailable with no members or no loaded rate', () => {
    expect(price({}, { exposure_base: null }).unavailableReason).toMatch(/no members/i);
    expect(price({}, {}, rates({ paBaseRates: [] })).unavailableReason).toMatch(/no PA base rate/i);
  });
});

describe('computeCandidates and the descriptor', () => {
  it('offers the PA rate as its exposure candidate', () => {
    expect(computeCandidates({ section: section(), rates: rates() }).map((c) => c.code))
      .toEqual(['PA_RATE']);
  });

  it('credits experience highly — PA claims settle fast', () => {
    expect(paBenefit.credibility.maxZ).toBe(0.85);
    expect(paBenefit.segment).toBe('ACCIDENT_HEALTH');
    expect(paBenefit.implemented).toBe(true);
  });
});
