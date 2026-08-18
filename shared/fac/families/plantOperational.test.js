import { describe, it, expect } from 'vitest';
import {
  readExposure, selectPlantRate, resolvePlantFactors, plantLossCost,
  computeCandidates, plantOperational, FACTOR_KINDS,
} from './plantOperational.js';

const TURBINE = { machine_type: 'GAS_TURBINE', territory: 'WORLDWIDE', rate_pm: 4.0, source: 'test' };
const TURBINE_KSA = { ...TURBINE, territory: 'KSA', rate_pm: 4.6 };
const TRANSFORMER = { ...TURBINE, machine_type: 'TRANSFORMER', rate_pm: 2.2 };

const FACTORS = [
  { factor_kind: 'AGE', factor_key: '0-5', factor: 0.9, source: 'test' },
  { factor_kind: 'AGE', factor_key: '16-25', factor: 1.35, source: 'test' },
  { factor_kind: 'USAGE', factor_key: 'THREE_SHIFT', factor: 1.25, source: 'test' },
  { factor_kind: 'MAINTENANCE', factor_key: 'OEM_CONTRACT', factor: 0.85, source: 'test' },
];

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'PLANT_OPERATIONAL',
  sum_insured: 50_000_000,
  exposure_detail: { machine_type: 'GAS_TURBINE', ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  plantBaseRates: [TURBINE, TURBINE_KSA, TRANSFORMER],
  plantFactors: FACTORS,
  ...o,
});

describe('readExposure', () => {
  it('treats a single machine as a one-item schedule', () => {
    const e = readExposure(section());
    expect(e.items).toHaveLength(1);
    expect(e.items[0].machineType).toBe('GAS_TURBINE');
    expect(e.totalValue).toBe(50_000_000);
  });

  it('reads an item schedule and totals the replacement values', () => {
    const e = readExposure(section({
      items: [
        { machine_type: 'gas_turbine', replacement_value: 40_000_000, pml_pct: 0.6 },
        { machine_type: 'transformer', replacement_value: 10_000_000 },
      ],
    }));
    expect(e.items).toHaveLength(2);
    expect(e.items[0].pmlPct).toBe(0.6);
    expect(e.totalValue).toBe(50_000_000);
  });

  it('survives a missing section', () => {
    const e = readExposure(null);
    expect(e.totalValue).toBe(0);
    expect(e.items[0].machineType).toBeNull();
  });
});

describe('selectPlantRate', () => {
  const pool = [TURBINE, TURBINE_KSA, TRANSFORMER];

  it('prefers the territory-specific rate', () => {
    expect(selectPlantRate(pool, { machineType: 'GAS_TURBINE', territory: 'KSA' }).rate)
      .toBe(TURBINE_KSA);
  });

  it('falls back to worldwide and says so', () => {
    const r = selectPlantRate(pool, { machineType: 'GAS_TURBINE', territory: 'EGYPT' });
    expect(r.rate).toBe(TURBINE);
    expect(r.fellBackToWorldwide).toBe(true);
  });

  it('never crosses machine type', () => {
    expect(selectPlantRate(pool, { machineType: 'PRESS', territory: 'WORLDWIDE' }).rate).toBeNull();
  });
});

describe('resolvePlantFactors', () => {
  it('multiplies, because an old machine on three shifts is a different risk', () => {
    const { factor } = resolvePlantFactors(FACTORS, {
      AGE: '16-25', USAGE: 'THREE_SHIFT', MAINTENANCE: 'OEM_CONTRACT',
    });
    expect(factor).toBeCloseTo(1.35 * 1.25 * 0.85, 12);
  });

  it('reports an unloaded factor instead of guessing one', () => {
    const { factor, missing } = resolvePlantFactors(FACTORS, { ENVIRONMENT: 'CORROSIVE' });
    expect(factor).toBe(1);
    expect(missing).toEqual(['ENVIRONMENT=CORROSIVE']);
  });

  it('applies the kinds the factor table constrains itself to', () => {
    expect(FACTOR_KINDS).toEqual(['AGE', 'USAGE', 'MAINTENANCE', 'ENVIRONMENT']);
  });
});

describe('plantLossCost', () => {
  const price = (detail = {}, overrides = {}, r = rates()) => plantLossCost({
    exposure: readExposure(section(detail, overrides)), rates: r,
  });

  it('rates each item on its own value and its own factors', () => {
    const out = price({
      items: [
        {
          machine_type: 'GAS_TURBINE', replacement_value: 40_000_000,
          age_band: '16-25', usage: 'THREE_SHIFT',
        },
        { machine_type: 'TRANSFORMER', replacement_value: 10_000_000, age_band: '0-5' },
      ],
    });
    expect(out.available).toBe(true);
    const turbine = (40_000_000 * 4.0 * 1.35 * 1.25) / 1000;
    const transformer = (10_000_000 * 2.2 * 0.9) / 1000;
    expect(out.lossCost).toBeCloseTo(turbine + transformer, 4);
    expect(out.diagnostics.items).toHaveLength(2);
  });

  it('applies the PML per item, which is the point of this family', () => {
    const withPml = price({
      items: [{ machine_type: 'GAS_TURBINE', replacement_value: 40_000_000, pml_pct: 0.5 }],
    });
    const without = price({
      items: [{ machine_type: 'GAS_TURBINE', replacement_value: 40_000_000 }],
    });
    expect(withPml.lossCost).toBeCloseTo(without.lossCost * 0.5, 6);
    expect(withPml.diagnostics.items[0].exposed_value).toBe(20_000_000);
  });

  it('rates an item at full value when no PML is stated, and says so', () => {
    const out = price();
    expect(out.diagnostics.items[0].exposed_value).toBe(50_000_000);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/plant PML is not a site PML/i);
  });

  it('prices what it can and reports the share of the schedule it could not', () => {
    const out = price({
      items: [
        { machine_type: 'GAS_TURBINE', replacement_value: 30_000_000 },
        { machine_type: 'PRESS', replacement_value: 10_000_000 },
      ],
    });
    expect(out.available).toBe(true);
    expect(out.diagnostics.rated_share).toBeCloseTo(0.75, 9);
    expect(out.diagnostics.unpriced).toHaveLength(1);
    expect(out.diagnostics.warnings.join(' ')).toContain('25.0%');
  });

  it('adds a stock-deterioration load pro rata to the indemnity period', () => {
    const out = price({ stock_value: 8_000_000, stock_indemnity_months: 6, stock_rate_pm: 1.5 });
    const stock = (8_000_000 * 1.5) / 1000 * 0.5;
    expect(out.diagnostics.stock_loss_cost).toBeCloseTo(stock, 6);
  });

  it('does not invent a stock rate', () => {
    const out = price({ stock_value: 8_000_000 });
    expect(out.diagnostics.stock_loss_cost).toBe(0);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/no deterioration rate/i);
  });

  it('reports unavailable when nothing on the schedule has a rate', () => {
    const out = price({ machine_type: 'PRESS' });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/no plant base rate is loaded/i);
  });

  it('reports unavailable with no replacement values', () => {
    const out = price({}, { sum_insured: null });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/replacement value/i);
  });

  it('expresses the rate per mille of the whole schedule value', () => {
    const out = price();
    expect(out.ratePm).toBeCloseTo((out.lossCost / 50_000_000) * 1000, 9);
  });
});

describe('computeCandidates and the descriptor', () => {
  it('offers the plant rate as its exposure candidate', () => {
    const c = computeCandidates({ section: section(), rates: rates() });
    expect(c.map((x) => x.code)).toEqual(['PLANT_RATE']);
  });

  it('rates per mille of value, annually, in the engineering segment', () => {
    expect(plantOperational.ratingBasis).toBe('SI_PER_MILLE');
    expect(plantOperational.segment).toBe('ENGINEERING_CONSTRUCTION');
    expect(plantOperational.implemented).toBe(true);
  });
});
