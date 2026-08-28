import { describe, it, expect } from 'vitest';
import {
  readExposure, selectMotorRate, tplLimitFactor, motorLossCost,
  computeCandidates, motorFleet, VEHICLE_CATEGORIES,
} from './motorFleet.js';

const PRIVATE = {
  vehicle_category: 'PRIVATE', territory: 'WORLDWIDE',
  od_cost_per_vehicle_year: 900, tpl_cost_per_vehicle_year: 400,
  tpl_basic_limit: 1_000_000, source: 'test',
};
const HEAVY = {
  ...PRIVATE, vehicle_category: 'HEAVY',
  od_cost_per_vehicle_year: 3_400, tpl_cost_per_vehicle_year: 2_100,
};
const PRIVATE_KSA = { ...PRIVATE, territory: 'KSA', od_cost_per_vehicle_year: 1_150 };

const MOTOR_CURVE = {
  curve_code: 'MOT-WW', kind: 'POWER', family_code: 'MOTOR_FLEET', territory: 'WORLDWIDE',
  basic_limit: 1_000_000, params: { doubling_loading: 0.15 },
};

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'MOTOR_FLEET',
  exposure_base: 500,
  sum_insured: 60_000_000,
  exposure_detail: { vehicle_category: 'PRIVATE', ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  motorBaseRates: [PRIVATE, HEAVY, PRIVATE_KSA],
  ilfCurves: [MOTOR_CURVE],
  ...o,
});

describe('readExposure', () => {
  it('treats a single-category fleet as one group', () => {
    const e = readExposure(section());
    expect(e.fleet).toHaveLength(1);
    expect(e.totalVehicles).toBe(500);
  });

  it('reads a fleet schedule and totals the vehicles', () => {
    const e = readExposure(section({
      fleet: [
        { vehicle_category: 'private', vehicle_count: 400, sum_insured: 30_000_000 },
        { vehicle_category: 'heavy', vehicle_count: 120, sum_insured: 40_000_000 },
      ],
    }));
    expect(e.totalVehicles).toBe(520);
    expect(e.totalSumInsured).toBe(70_000_000);
    expect(e.fleet[1].category).toBe('HEAVY');
  });

  it('knows the categories the rate table constrains itself to', () => {
    expect(VEHICLE_CATEGORIES).toEqual(
      ['PRIVATE', 'COMMERCIAL', 'HEAVY', 'SPECIAL', 'MOTORCYCLE'],
    );
  });
});

describe('selectMotorRate', () => {
  const pool = [PRIVATE, HEAVY, PRIVATE_KSA];

  it('prefers the territory-specific rate', () => {
    expect(selectMotorRate(pool, { category: 'PRIVATE', territory: 'KSA' }).rate)
      .toBe(PRIVATE_KSA);
  });

  it('never crosses vehicle category', () => {
    expect(selectMotorRate(pool, { category: 'MOTORCYCLE', territory: 'WORLDWIDE' }).rate)
      .toBeNull();
  });
});

describe('tplLimitFactor', () => {
  it('is exactly 1 at the basic limit', () => {
    expect(tplLimitFactor({ limit: 1_000_000, basicLimit: 1_000_000, curve: MOTOR_CURVE }))
      .toEqual({ factor: 1, basis: 'AT_BASIC_LIMIT' });
  });

  it('steps a higher limit through the motor curve', () => {
    const { factor } = tplLimitFactor({
      limit: 4_000_000, basicLimit: 1_000_000, curve: MOTOR_CURVE,
    });
    expect(factor).toBeCloseTo(4 ** Math.log2(1.15), 10);
  });

  it('does not invent a step when no curve is loaded', () => {
    const r = tplLimitFactor({ limit: 4_000_000, basicLimit: 1_000_000, curve: null });
    expect(r).toEqual({ factor: 1, basis: 'NO_CURVE_LOADED' });
  });

  it('treats an unstated limit as the basic limit, not as unlimited exposure', () => {
    expect(tplLimitFactor({ limit: null, basicLimit: 1_000_000, curve: MOTOR_CURVE }).factor)
      .toBe(1);
  });
});

describe('motorLossCost', () => {
  const price = (detail = {}, overrides = {}, r = rates()) => motorLossCost({
    exposure: readExposure(section(detail, overrides)), rates: r,
  });

  it('costs own damage and liability per vehicle-year', () => {
    const out = price();
    expect(out.available).toBe(true);
    expect(out.lossCost).toBeCloseTo(500 * 900 + 500 * 400, 6);
    expect(out.diagnostics.cost_per_vehicle_year).toBeCloseTo(1_300, 6);
  });

  it('rates each category on its own cost', () => {
    const out = price({
      fleet: [
        { vehicle_category: 'PRIVATE', vehicle_count: 400 },
        { vehicle_category: 'HEAVY', vehicle_count: 100 },
      ],
    });
    expect(out.lossCost).toBeCloseTo(400 * 1_300 + 100 * 5_500, 6);
    expect(out.diagnostics.groups).toHaveLength(2);
  });

  it('steps the liability cost when a limit above the basic one is written', () => {
    const atBasic = price({}, { limit_amount: 1_000_000 });
    const higher = price({}, { limit_amount: 4_000_000 });
    const step = 4 ** Math.log2(1.15);
    expect(higher.diagnostics.groups[0].tpl_limit_factor).toBeCloseTo(step, 10);
    expect(higher.lossCost).toBeGreaterThan(atBasic.lossCost);
    // Own damage is untouched by the liability limit.
    expect(higher.diagnostics.groups[0].od_cost).toBe(atBasic.diagnostics.groups[0].od_cost);
  });

  it('says so when a higher limit is written with no curve to step it', () => {
    const out = price({}, { limit_amount: 4_000_000 }, rates({ ilfCurves: [] }));
    expect(out.diagnostics.groups[0].tpl_limit_factor).toBe(1);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/understates the layer/i);
  });

  it('applies the fleet-rating adjustment last and keeps it visible', () => {
    const out = price({ ncd_pct: 0.15 });
    expect(out.diagnostics.loss_cost_before_ncd).toBeCloseTo(500 * 1_300, 6);
    expect(out.lossCost).toBeCloseTo(500 * 1_300 * 0.85, 6);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/negotiated number, not a table value/i);
  });

  it('prices what it can and reports the vehicles it could not', () => {
    const out = price({
      fleet: [
        { vehicle_category: 'PRIVATE', vehicle_count: 400 },
        { vehicle_category: 'MOTORCYCLE', vehicle_count: 60 },
      ],
    });
    expect(out.available).toBe(true);
    expect(out.diagnostics.rated_vehicles).toBe(400);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/60 vehicles/);
  });

  it('charges no own damage on a TPL-only fleet (F11)', () => {
    // 200 PRIVATE vehicles at od 900 / tpl 400 per vehicle-year:
    // comprehensive = 200 × 1,300 = 260,000; TPL-only = 200 × 400 = 80,000.
    const comp = price({ cover_basis: 'COMPREHENSIVE' }, { exposure_base: 200 });
    const tpl = price({ cover_basis: 'TPL_ONLY' }, { exposure_base: 200 });
    expect(comp.lossCost).toBeCloseTo(260_000, 6);
    expect(tpl.lossCost).toBeCloseTo(80_000, 6);
    expect(tpl.diagnostics.groups[0].od_cost).toBe(0);
    expect(tpl.diagnostics.groups[0].tpl_cost).toBeCloseTo(80_000, 6);
    expect(comp.diagnostics.cover_basis).toBe('COMPREHENSIVE');
    expect(tpl.diagnostics.cover_basis).toBe('TPL_ONLY');
  });

  it('defaults an unstated cover basis to comprehensive, and says which it used', () => {
    const out = price();
    expect(out.diagnostics.cover_basis).toBe('COMPREHENSIVE');
    expect(out.lossCost).toBeCloseTo(500 * 1_300, 6);
  });

  it('still steps the TPL limit on a TPL-only fleet', () => {
    const out = price({ cover_basis: 'TPL_ONLY' }, { exposure_base: 200, limit_amount: 4_000_000 });
    const step = 4 ** Math.log2(1.15);
    expect(out.lossCost).toBeCloseTo(200 * 400 * step, 6);
  });

  it('expresses a rate per mille of the fleet values where there are any', () => {
    const out = price();
    expect(out.ratePm).toBeCloseTo((out.lossCost / 60_000_000) * 1000, 9);
    expect(price({}, { sum_insured: null }).ratePm).toBeNull();
  });

  it('reports unavailable with no vehicles or no loaded rate', () => {
    expect(price({}, { exposure_base: null }).unavailableReason).toMatch(/no vehicles/i);
    expect(price({}, {}, rates({ motorBaseRates: [] })).unavailableReason)
      .toMatch(/no motor base rate/i);
  });
});

describe('computeCandidates and the descriptor', () => {
  it('offers the motor rate as its exposure candidate', () => {
    expect(computeCandidates({ section: section(), rates: rates() }).map((c) => c.code))
      .toEqual(['MOTOR_RATE']);
  });

  it('credits the risk\'s own experience further than any other family', () => {
    expect(motorFleet.credibility.maxZ).toBe(0.90);
    expect(motorFleet.credibility.k).toBe(4);
    expect(motorFleet.ratingBasis).toBe('PER_UNIT');
    expect(motorFleet.implemented).toBe(true);
  });
});
