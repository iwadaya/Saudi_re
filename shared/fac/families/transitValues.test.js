import { describe, it, expect } from 'vitest';
import {
  readExposure, selectTransitRate, selectWarRate, warSectionLossCost,
  transitLossCost, computeCandidates, transitValues, CONVEYANCES,
} from './transitValues.js';

// Fixtures. fac_transit_base_rate and fac_war_rate both ship empty.
const MACHINERY_SEA = {
  commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE',
  rate_pm: 0.6, packing_factor: null, source: 'test',
};
const MACHINERY_SEA_WAF = {
  ...MACHINERY_SEA, route_region: 'WEST_AFRICA', rate_pm: 1.4,
};
const ELECTRONICS_AIR = {
  commodity: 'ELECTRONICS', conveyance: 'AIR', route_region: 'WORLDWIDE',
  rate_pm: 0.25, packing_factor: 1.1, source: 'test',
};

const WAR_GULF_ANNUAL = {
  region: 'ARABIAN_GULF', basis: 'ANNUAL', rate_pm: 0.35, breach_ap_pm: 0.9,
  effective_from: '2026-01-01', source: 'test',
};
const WAR_GULF_ANNUAL_NEWER = {
  ...WAR_GULF_ANNUAL, rate_pm: 0.75, effective_from: '2026-06-01',
};
const WAR_RED_SEA_TRANSIT = {
  region: 'RED_SEA', basis: 'PER_TRANSIT', rate_pm: 4.0, breach_ap_pm: null,
  effective_from: '2026-05-01', source: 'test',
};

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'TRANSIT_VALUES',
  exposure_base: 100_000_000,
  limit_amount: 5_000_000,
  exposure_detail: { commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE', ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  transitRates: [MACHINERY_SEA, MACHINERY_SEA_WAF, ELECTRONICS_AIR],
  warRates: [WAR_GULF_ANNUAL, WAR_GULF_ANNUAL_NEWER, WAR_RED_SEA_TRANSIT],
  ...o,
});

describe('readExposure', () => {
  it('treats a single-commodity account as one segment on the section columns', () => {
    const e = readExposure(section());
    expect(e.segments).toHaveLength(1);
    expect(e.segments[0]).toMatchObject({
      commodity: 'MACHINERY', conveyance: 'SEA', routeRegion: 'WORLDWIDE', turnover: 100_000_000,
    });
    expect(e.totalTurnover).toBe(100_000_000);
  });

  it('reads a multi-segment schedule and totals the turnover', () => {
    const e = readExposure(section({
      segments: [
        { commodity: 'machinery', conveyance: 'sea', route_region: 'worldwide', turnover: 60_000_000 },
        { commodity: 'electronics', conveyance: 'air', turnover: 40_000_000 },
      ],
    }));
    expect(e.segments).toHaveLength(2);
    expect(e.segments[1].routeRegion).toBe('WORLDWIDE');
    expect(e.totalTurnover).toBe(100_000_000);
  });

  it('takes the any-one-conveyance limit as the accumulation control, not a rating base', () => {
    const e = readExposure(section({ max_any_one_conveyance: 8_000_000, max_any_one_location: 3_000_000 }));
    expect(e.maxAnyOneConveyance).toBe(8_000_000);
    expect(e.maxAnyOneLocation).toBe(3_000_000);
    // The turnover, not the limit, is what gets rated.
    expect(e.totalTurnover).toBe(100_000_000);
  });

  it('falls back to the section limit for the any-one-conveyance cap', () => {
    expect(readExposure(section()).maxAnyOneConveyance).toBe(5_000_000);
  });

  it('warns about a conveyance it does not rate', () => {
    const e = readExposure(section({ conveyance: 'PIPELINE' }));
    expect(e.warnings).toHaveLength(1);
    expect(e.warnings[0]).toContain('PIPELINE');
  });

  it('knows the conveyances the rate table constrains itself to', () => {
    expect(CONVEYANCES).toEqual(['SEA', 'AIR', 'ROAD', 'RAIL', 'MULTIMODAL']);
  });

  it('survives a missing section', () => {
    const e = readExposure(null);
    expect(e.totalTurnover).toBe(0);
    expect(e.segments).toHaveLength(1);
    expect(e.segments[0].turnover).toBeNull();
  });
});

describe('selectTransitRate', () => {
  const pool = [MACHINERY_SEA, MACHINERY_SEA_WAF, ELECTRONICS_AIR];

  it('prefers the route-specific rate', () => {
    const { rate, fellBackToWorldwide } = selectTransitRate(pool, {
      commodity: 'MACHINERY', conveyance: 'SEA', routeRegion: 'WEST_AFRICA',
    });
    expect(rate).toBe(MACHINERY_SEA_WAF);
    expect(fellBackToWorldwide).toBe(false);
  });

  it('falls back to worldwide and says so', () => {
    const { rate, fellBackToWorldwide } = selectTransitRate(pool, {
      commodity: 'MACHINERY', conveyance: 'SEA', routeRegion: 'BALTIC',
    });
    expect(rate).toBe(MACHINERY_SEA);
    expect(fellBackToWorldwide).toBe(true);
  });

  it('never crosses commodity or conveyance', () => {
    expect(selectTransitRate(pool, {
      commodity: 'MACHINERY', conveyance: 'AIR', routeRegion: 'WORLDWIDE',
    }).rate).toBeNull();
    expect(selectTransitRate(pool, {
      commodity: 'FROZEN_FOOD', conveyance: 'SEA', routeRegion: 'WORLDWIDE',
    }).rate).toBeNull();
  });
});

describe('selectWarRate', () => {
  const pool = [WAR_GULF_ANNUAL, WAR_GULF_ANNUAL_NEWER, WAR_RED_SEA_TRANSIT];

  it('takes the most recently effective row — war rates move weekly', () => {
    expect(selectWarRate(pool, { region: 'ARABIAN_GULF' })).toBe(WAR_GULF_ANNUAL_NEWER);
  });

  it('matches on basis as well as region', () => {
    expect(selectWarRate(pool, { region: 'RED_SEA', basis: 'PER_TRANSIT' })).toBe(WAR_RED_SEA_TRANSIT);
    expect(selectWarRate(pool, { region: 'RED_SEA', basis: 'ANNUAL' })).toBeNull();
  });

  it('returns nothing for an unrated region', () => {
    expect(selectWarRate(pool, { region: 'BLACK_SEA' })).toBeNull();
    expect(selectWarRate([], { region: 'RED_SEA' })).toBeNull();
  });
});

describe('warSectionLossCost', () => {
  it('rates an annual war section once against the values', () => {
    const r = warSectionLossCost({ insuredValue: 100_000_000, warRate: WAR_GULF_ANNUAL_NEWER });
    expect(r.available).toBe(true);
    expect(r.lossCost).toBeCloseTo((100_000_000 * 0.75) / 1000, 6);
    expect(r.diagnostics.transits).toBe(1);
  });

  it('rates a per-transit war section per sailing', () => {
    const r = warSectionLossCost({
      insuredValue: 5_000_000, warRate: WAR_RED_SEA_TRANSIT, transits: 12,
    });
    expect(r.lossCost).toBeCloseTo((5_000_000 * 4.0) / 1000 * 12, 6);
    expect(r.diagnostics.basis).toBe('PER_TRANSIT');
  });

  it('refuses a per-transit rate with no transit count', () => {
    const r = warSectionLossCost({ insuredValue: 5_000_000, warRate: WAR_RED_SEA_TRANSIT });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/per transit/i);
  });

  it('adds the breach-of-warranty AP only when the breach applies', () => {
    const plain = warSectionLossCost({ insuredValue: 100_000_000, warRate: WAR_GULF_ANNUAL_NEWER });
    const breach = warSectionLossCost({
      insuredValue: 100_000_000, warRate: WAR_GULF_ANNUAL_NEWER, breachOfWarranty: true,
    });
    expect(breach.ratePm).toBeCloseTo(0.75 + 0.9, 9);
    expect(breach.lossCost).toBeGreaterThan(plain.lossCost);
  });

  it('reports unavailable, with a reason, when no war rate is loaded', () => {
    const r = warSectionLossCost({ insuredValue: 100_000_000, warRate: null });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/never a percentage loading/i);
  });

  it('carries the effective date and source through, so a moved rate is visible', () => {
    const r = warSectionLossCost({ insuredValue: 100_000_000, warRate: WAR_GULF_ANNUAL_NEWER });
    expect(r.diagnostics.effective_from).toBe('2026-06-01');
    expect(r.diagnostics.source).toBe('test');
  });
});

describe('transitLossCost', () => {
  it('rates a single-segment account against turnover, not the conveyance limit', () => {
    const r = transitLossCost({
      exposure: readExposure(section()), transitRates: rates().transitRates,
    });
    expect(r.available).toBe(true);
    expect(r.lossCost).toBeCloseTo((100_000_000 * 0.6) / 1000, 6);
    expect(r.ratePm).toBeCloseTo(0.6, 9);
  });

  it('blends a multi-segment account by turnover', () => {
    const exposure = readExposure(section({
      segments: [
        { commodity: 'MACHINERY', conveyance: 'SEA', turnover: 60_000_000 },
        { commodity: 'ELECTRONICS', conveyance: 'AIR', turnover: 40_000_000 },
      ],
    }));
    const r = transitLossCost({ exposure, transitRates: rates().transitRates });
    // 60m × 0.6‰ + 40m × 0.25‰ × 1.1 packing
    const expected = (60_000_000 * 0.6) / 1000 + (40_000_000 * 0.25 * 1.1) / 1000;
    expect(r.lossCost).toBeCloseTo(expected, 6);
    expect(r.diagnostics.blended_transit_rate_pm).toBeCloseTo((expected / 100_000_000) * 1000, 9);
    expect(r.diagnostics.segments).toHaveLength(2);
  });

  it('lets a segment override the table packing factor', () => {
    const exposure = readExposure(section({
      segments: [{ commodity: 'ELECTRONICS', conveyance: 'AIR', turnover: 10_000_000, packing_factor: 0.9 }],
    }));
    const r = transitLossCost({ exposure, transitRates: rates().transitRates });
    expect(r.diagnostics.segments[0].packing_factor).toBe(0.9);
    expect(r.lossCost).toBeCloseTo((10_000_000 * 0.25 * 0.9) / 1000, 6);
  });

  it('prices what it can and says how much of the turnover it could not rate', () => {
    const exposure = readExposure(section({
      segments: [
        { commodity: 'MACHINERY', conveyance: 'SEA', turnover: 75_000_000 },
        { commodity: 'LIVESTOCK', conveyance: 'SEA', turnover: 25_000_000 },
      ],
    }));
    const r = transitLossCost({ exposure, transitRates: rates().transitRates });
    expect(r.available).toBe(true);
    expect(r.diagnostics.rated_share).toBeCloseTo(0.75, 9);
    expect(r.diagnostics.unpriced).toHaveLength(1);
    expect(r.diagnostics.warnings.join(' ')).toContain('25.0%');
  });

  it('reports unavailable when nothing in the schedule has a rate', () => {
    const r = transitLossCost({
      exposure: readExposure(section({ commodity: 'LIVESTOCK' })), transitRates: rates().transitRates,
    });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/no cargo rate is loaded/i);
  });

  it('reports unavailable when the account states no turnover', () => {
    const r = transitLossCost({
      exposure: readExposure(section({}, { exposure_base: null })),
      transitRates: rates().transitRates,
    });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/annual sendings/i);
  });

  it('adds a storage load pro rata to the storage period, kept visible', () => {
    const exposure = readExposure(section({
      storage_values: 20_000_000, storage_months: 6, storage_rate_pm: 0.4,
    }));
    const r = transitLossCost({ exposure, transitRates: rates().transitRates });
    const storage = (20_000_000 * 0.4) / 1000 * 0.5;
    expect(r.diagnostics.storage_loss_cost).toBeCloseTo(storage, 6);
    expect(r.lossCost).toBeCloseTo((100_000_000 * 0.6) / 1000 + storage, 6);
  });

  it('does not invent a storage rate', () => {
    const exposure = readExposure(section({ storage_values: 20_000_000 }));
    const r = transitLossCost({ exposure, transitRates: rates().transitRates });
    expect(r.diagnostics.storage_loss_cost).toBe(0);
    expect(r.diagnostics.warnings.join(' ')).toMatch(/no storage rate/i);
  });

  it('flags a route fallback', () => {
    const exposure = readExposure(section({ route_region: 'BALTIC' }));
    const r = transitLossCost({ exposure, transitRates: rates().transitRates });
    expect(r.diagnostics.segments[0].route_fallback).toBe(true);
    expect(r.diagnostics.warnings.join(' ')).toMatch(/worldwide route rate/i);
  });

  it('carries the accumulation limits into the diagnostics for the capacity check', () => {
    const r = transitLossCost({
      exposure: readExposure(section({ max_any_one_conveyance: 8_000_000, max_any_one_location: 3_000_000 })),
      transitRates: rates().transitRates,
    });
    expect(r.diagnostics.max_any_one_conveyance).toBe(8_000_000);
    expect(r.diagnostics.max_any_one_location).toBe(3_000_000);
  });
});

describe('computeCandidates', () => {
  it('gives the transit rate alone when no war region is stated', () => {
    const c = computeCandidates({ section: section(), rates: rates() });
    expect(c.map((x) => x.code)).toEqual(['TRANSIT_RATE']);
  });

  it('prices war as its own candidate, never folded into the cargo rate', () => {
    const c = computeCandidates({
      section: section({ war_region: 'ARABIAN_GULF' }), rates: rates(),
    });
    expect(c.map((x) => x.code)).toEqual(['TRANSIT_RATE', 'WAR_SECTION']);
    const cargo = c[0].result;
    const war = c[1].result;
    // The cargo rate is untouched by the war region.
    expect(cargo.lossCost).toBeCloseTo((100_000_000 * 0.6) / 1000, 6);
    expect(war.lossCost).toBeCloseTo((100_000_000 * 0.75) / 1000, 6);
  });

  it('rates a per-transit war section off the any-one-conveyance value', () => {
    const c = computeCandidates({
      section: section({
        war_region: 'RED_SEA', war_basis: 'PER_TRANSIT', transit_count: 8,
        max_any_one_conveyance: 5_000_000,
      }),
      rates: rates(),
    });
    expect(c[1].result.lossCost).toBeCloseTo((5_000_000 * 4.0) / 1000 * 8, 6);
  });

  it('reports the war section unavailable without silencing the cargo rate', () => {
    const c = computeCandidates({
      section: section({ war_region: 'BLACK_SEA' }), rates: rates(),
    });
    expect(c[0].result.available).toBe(true);
    expect(c[1].result.available).toBe(false);
  });
});

describe('the family descriptor', () => {
  it('rates on turnover, not on a sum insured', () => {
    expect(transitValues.code).toBe('TRANSIT_VALUES');
    expect(transitValues.ratingBasis).toBe('TURNOVER');
    expect(transitValues.implemented).toBe(true);
    expect(transitValues.segment).toBe('MARINE_TRANSIT');
  });

  it('credits experience sooner than the other families — cargo is high frequency', () => {
    expect(transitValues.credibility.k).toBeLessThan(8);
    expect(transitValues.credibility.maxZ).toBe(0.80);
  });
});
