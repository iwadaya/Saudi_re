import { describe, it, expect } from 'vitest';
import {
  readExposure, vesselAge, selectHullRate, resolveHullFactors, ageBandKey,
  hullLossCost, computeCandidates, hullValue, FACTOR_KINDS,
} from './hullValue.js';

// Fixtures. fac_hull_base_rate and fac_hull_factor both ship empty.
const BULKER_SMALL = {
  vessel_type: 'BULK_CARRIER', tonnage_min: 0, tonnage_max: 20_000,
  rate_pm: 5.0, source: 'test',
};
const BULKER_LARGE = {
  vessel_type: 'BULK_CARRIER', tonnage_min: 20_000, tonnage_max: 80_000,
  rate_pm: 3.5, source: 'test',
};
const BULKER_CAPE = {
  vessel_type: 'BULK_CARRIER', tonnage_min: 80_000, tonnage_max: null,
  rate_pm: 3.0, source: 'test',
};
const TANKER = {
  vessel_type: 'TANKER', tonnage_min: 0, tonnage_max: null, rate_pm: 6.0, source: 'test',
};

const FACTORS = [
  { factor_kind: 'AGE', factor_key: '0-5', factor: 0.9, source: 'test' },
  { factor_kind: 'AGE', factor_key: '6-15', factor: 1.0, source: 'test' },
  { factor_kind: 'AGE', factor_key: '16-25', factor: 1.25, source: 'test' },
  { factor_kind: 'AGE', factor_key: '26+', factor: 1.6, source: 'test' },
  { factor_kind: 'CLASS', factor_key: 'IACS', factor: 1.0, source: 'test' },
  { factor_kind: 'CLASS', factor_key: 'NON_IACS', factor: 1.3, source: 'test' },
  { factor_kind: 'TRADING_AREA', factor_key: 'WORLDWIDE', factor: 1.0, source: 'test' },
  { factor_kind: 'TRADING_AREA', factor_key: 'ICE', factor: 1.4, source: 'test' },
  { factor_kind: 'MANAGEMENT', factor_key: 'ISM_DOC', factor: 0.95, source: 'test' },
  { factor_kind: 'CLAIMS', factor_key: 'CLEAN_5YR', factor: 0.85, source: 'test' },
];

const WAR_GULF = {
  region: 'ARABIAN_GULF', basis: 'ANNUAL', rate_pm: 0.75, breach_ap_pm: 0.9,
  effective_from: '2026-06-01', source: 'test',
};

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'HULL_VALUE',
  sum_insured: 30_000_000,
  exposure_detail: {
    vessel_type: 'BULK_CARRIER', tonnage: 45_000, ...detail,
  },
  ...overrides,
});

const rates = (o = {}) => ({
  hullRates: [BULKER_SMALL, BULKER_LARGE, BULKER_CAPE, TANKER],
  hullFactors: FACTORS,
  warRates: [WAR_GULF],
  ...o,
});

describe('readExposure', () => {
  it('takes the agreed value from the section sum insured', () => {
    expect(readExposure(section()).agreedValue).toBe(30_000_000);
  });

  it('falls back to an agreed value stated in the detail', () => {
    const e = readExposure(section({ agreed_value: 12_000_000 }, { sum_insured: null }));
    expect(e.agreedValue).toBe(12_000_000);
  });

  it('upper-cases the categorical keys the factor table matches on', () => {
    const e = readExposure(section({
      class_society: 'iacs', flag: 'panama', trading_area: 'ice', management: 'ism_doc',
      claims_band: 'clean_5yr',
    }));
    expect(e.classSociety).toBe('IACS');
    expect(e.flag).toBe('PANAMA');
    expect(e.tradingArea).toBe('ICE');
    expect(e.management).toBe('ISM_DOC');
    expect(e.claimsBand).toBe('CLEAN_5YR');
  });

  it('survives a missing section', () => {
    const e = readExposure(null);
    expect(e.agreedValue).toBeNull();
    expect(e.vesselType).toBeNull();
    expect(e.tonnage).toBeNull();
  });
});

describe('vesselAge', () => {
  it('prefers an explicitly stated age', () => {
    expect(vesselAge({ age: 12, buildYear: 2000 }, '2026-01-01')).toBe(12);
  });

  it('derives the age from the build year and inception', () => {
    expect(vesselAge({ age: null, buildYear: 2011 }, '2026-04-01')).toBe(15);
  });

  it('never returns a negative age for a newbuild delivering next year', () => {
    expect(vesselAge({ age: null, buildYear: 2027 }, '2026-04-01')).toBe(0);
  });

  it('returns null rather than guessing when neither is known', () => {
    expect(vesselAge({ age: null, buildYear: null }, '2026-01-01')).toBeNull();
    expect(vesselAge({ age: null, buildYear: 2011 }, null)).toBeNull();
  });
});

describe('selectHullRate', () => {
  it('picks the band the tonnage falls in', () => {
    expect(selectHullRate([BULKER_SMALL, BULKER_LARGE, BULKER_CAPE], {
      vesselType: 'BULK_CARRIER', tonnage: 45_000,
    })).toBe(BULKER_LARGE);
  });

  it('treats bands as half-open, so a boundary tonnage matches exactly one', () => {
    expect(selectHullRate([BULKER_SMALL, BULKER_LARGE], {
      vesselType: 'BULK_CARRIER', tonnage: 20_000,
    })).toBe(BULKER_LARGE);
  });

  it('handles an open-ended top band', () => {
    expect(selectHullRate([BULKER_SMALL, BULKER_LARGE, BULKER_CAPE], {
      vesselType: 'BULK_CARRIER', tonnage: 180_000,
    })).toBe(BULKER_CAPE);
  });

  it('never crosses vessel type', () => {
    expect(selectHullRate([TANKER], { vesselType: 'BULK_CARRIER', tonnage: 45_000 })).toBeNull();
  });

  it('returns nothing without a tonnage to place', () => {
    expect(selectHullRate([BULKER_LARGE], { vesselType: 'BULK_CARRIER', tonnage: null })).toBeNull();
  });
});

describe('ageBandKey', () => {
  it('places an age inside a closed band', () => {
    expect(ageBandKey(FACTORS, 3)).toBe('0-5');
    expect(ageBandKey(FACTORS, 15)).toBe('6-15');
    expect(ageBandKey(FACTORS, 20)).toBe('16-25');
  });

  it('places an age in an open-ended band', () => {
    expect(ageBandKey(FACTORS, 40)).toBe('26+');
  });

  it('returns null when the age falls in no loaded band', () => {
    expect(ageBandKey([{ factor_kind: 'AGE', factor_key: '0-5', factor: 1 }], 30)).toBeNull();
    expect(ageBandKey(FACTORS, null)).toBeNull();
  });
});

describe('resolveHullFactors', () => {
  it('multiplies the factors that are loaded', () => {
    const { factor, applied, missing } = resolveHullFactors(FACTORS, {
      AGE: '16-25', CLASS: 'IACS', TRADING_AREA: 'ICE', MANAGEMENT: 'ISM_DOC', CLAIMS: 'CLEAN_5YR',
    });
    expect(factor).toBeCloseTo(1.25 * 1.0 * 1.4 * 0.95 * 0.85, 12);
    expect(Object.keys(applied)).toEqual(['AGE', 'CLASS', 'TRADING_AREA', 'MANAGEMENT', 'CLAIMS']);
    expect(missing).toEqual([]);
  });

  it('reports a key with no loaded factor instead of guessing one', () => {
    const { factor, missing } = resolveHullFactors(FACTORS, { FLAG: 'PANAMA', CLASS: 'IACS' });
    expect(factor).toBe(1);
    expect(missing).toEqual(['FLAG=PANAMA']);
  });

  it('ignores keys that were never stated', () => {
    const { factor, missing } = resolveHullFactors(FACTORS, { CLASS: 'NON_IACS', FLAG: null, AGE: '' });
    expect(factor).toBe(1.3);
    expect(missing).toEqual([]);
  });

  it('applies the kinds in the documented order', () => {
    expect(FACTOR_KINDS).toEqual(['AGE', 'CLASS', 'FLAG', 'TRADING_AREA', 'MANAGEMENT', 'CLAIMS']);
  });
});

describe('hullLossCost', () => {
  const price = (detail = {}, overrides = {}, r = rates(), inception = '2026-01-01') => hullLossCost({
    exposure: readExposure(section(detail, overrides)),
    hullRates: r.hullRates,
    hullFactors: r.hullFactors,
    inceptionDate: inception,
  });

  it('rates per mille of agreed value off the base rate and the factors', () => {
    const r = price({ build_year: 2005, class_society: 'IACS', trading_area: 'WORLDWIDE' });
    expect(r.available).toBe(true);
    // 45,000 GT bulker → 3.5‰; age 21 → 1.25; IACS → 1.00; worldwide → 1.00
    expect(r.diagnostics.base_rate_pm).toBe(3.5);
    expect(r.diagnostics.factor_product).toBeCloseTo(1.25, 12);
    expect(r.diagnostics.hull_rate_pm).toBeCloseTo(4.375, 12);
    expect(r.lossCost).toBeCloseTo((30_000_000 * 4.375) / 1000, 6);
  });

  it('names the tonnage band it used', () => {
    expect(price().diagnostics.tonnage_band).toBe('20000–80000');
    expect(price({ tonnage: 180_000 }).diagnostics.tonnage_band).toBe('80000–∞');
  });

  it('reports unavailable, with a reason, when no rate is loaded for the vessel', () => {
    const r = price({ vessel_type: 'FISHING_VESSEL' });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toContain('FISHING_VESSEL');
  });

  it('reports unavailable without an agreed value', () => {
    const r = price({}, { sum_insured: null });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/agreed value/i);
  });

  it('reports unavailable without a vessel type or tonnage', () => {
    expect(price({ vessel_type: null }).unavailableReason).toMatch(/vessel type/i);
    expect(price({ tonnage: null }).unavailableReason).toMatch(/tonnage/i);
  });

  it('treats an unloaded factor as 1.00 and says so rather than inventing a loading', () => {
    const r = price({ flag: 'PANAMA', class_society: 'IACS' });
    expect(r.diagnostics.factors_missing).toEqual(['FLAG=PANAMA']);
    expect(r.diagnostics.factor_product).toBe(1);
    expect(r.diagnostics.warnings.join(' ')).toContain('FLAG=PANAMA');
  });

  it('warns when it has no age to band the vessel by', () => {
    const r = price();
    expect(r.diagnostics.age).toBeNull();
    expect(r.diagnostics.warnings.join(' ')).toMatch(/no vessel age/i);
  });

  it('adds increased value only when it carries its own rate', () => {
    const withRate = price({ increased_value: 3_000_000, increased_value_rate_pm: 2.0 });
    const without = price({ increased_value: 3_000_000 });
    expect(withRate.diagnostics.increased_value_loss_cost).toBeCloseTo(6_000, 6);
    expect(without.diagnostics.increased_value_loss_cost).toBe(0);
    expect(without.diagnostics.warnings.join(' ')).toMatch(/IV rate/);
  });

  it('returns laid-up premium pro rata as to time', () => {
    const base = price({ build_year: 2005 });
    const laidUp = price({ build_year: 2005, laid_up_days: 73, laid_up_return_pct: 0.5 });
    // 73/365 = 20% of the year at a 50% return → 10% off.
    expect(laidUp.lossCost).toBeCloseTo(base.lossCost * 0.9, 6);
    expect(laidUp.diagnostics.laid_up_return).toBeCloseTo(base.lossCost * 0.1, 6);
  });

  it('does not invent a laid-up return percentage', () => {
    const r = price({ laid_up_days: 90 });
    expect(r.diagnostics.laid_up_return).toBe(0);
    expect(r.diagnostics.warnings.join(' ')).toMatch(/laid-up return/i);
  });

  it('reports the effective rate per mille of agreed value, IV and returns included', () => {
    const r = price({ build_year: 2005, increased_value: 3_000_000, increased_value_rate_pm: 2.0 });
    expect(r.ratePm).toBeCloseTo((r.lossCost / 30_000_000) * 1000, 9);
  });
});

describe('computeCandidates', () => {
  it('gives the hull rate alone when no war region is stated', () => {
    const c = computeCandidates({ risk: { period_from: '2026-01-01' }, section: section(), rates: rates() });
    expect(c.map((x) => x.code)).toEqual(['HULL_RATE']);
  });

  it('prices hull war as a separate section, never a loading on the hull rate', () => {
    const plain = computeCandidates({
      risk: { period_from: '2026-01-01' }, section: section({ build_year: 2005 }), rates: rates(),
    });
    const withWar = computeCandidates({
      risk: { period_from: '2026-01-01' },
      section: section({ build_year: 2005, war_region: 'ARABIAN_GULF' }),
      rates: rates(),
    });
    expect(withWar.map((x) => x.code)).toEqual(['HULL_RATE', 'WAR_SECTION']);
    // The H&M rate is identical with and without the war section.
    expect(withWar[0].result.lossCost).toBeCloseTo(plain[0].result.lossCost, 9);
    expect(withWar[1].result.lossCost).toBeCloseTo((30_000_000 * 0.75) / 1000, 6);
  });

  it('applies the breach-of-warranty AP to the war section', () => {
    const c = computeCandidates({
      risk: { period_from: '2026-01-01' },
      section: section({ war_region: 'ARABIAN_GULF', breach_of_warranty: true }),
      rates: rates(),
    });
    expect(c[1].result.ratePm).toBeCloseTo(0.75 + 0.9, 9);
  });

  it('ages the vessel off the risk inception date', () => {
    const c = computeCandidates({
      risk: { period_from: '2026-01-01' }, section: section({ build_year: 2018 }), rates: rates(),
    });
    expect(c[0].result.diagnostics.age).toBe(8);
    expect(c[0].result.diagnostics.factors_applied.AGE.key).toBe('6-15');
  });
});

describe('the family descriptor', () => {
  it('rates per mille of value and sits in the marine segment', () => {
    expect(hullValue.code).toBe('HULL_VALUE');
    expect(hullValue.ratingBasis).toBe('AGREED_VALUE');
    expect(hullValue.segment).toBe('MARINE_TRANSIT');
    expect(hullValue.implemented).toBe(true);
    expect(hullValue.methods).toContain('HULL_RATE');
  });

  it('sits between property and casualty on credibility', () => {
    expect(hullValue.credibility.k).toBe(8);
    expect(hullValue.credibility.maxZ).toBe(0.70);
  });
});
