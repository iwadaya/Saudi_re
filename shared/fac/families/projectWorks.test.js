import { describe, it, expect } from 'vitest';
import {
  readExposure, selectProjectRate, resolveProjectFactors, loadCost,
  projectLossCost, computeCandidates, projectWorks, FACTOR_KINDS, LOAD_KINDS,
} from './projectWorks.js';

// Fixtures. fac_project_* all ship empty (migration 137).
const POWER_MID = {
  project_type: 'POWER', territory: 'WORLDWIDE',
  contract_value_min: 50_000_000, contract_value_max: 500_000_000,
  rate_pm: 2.5, period_factor_per_month: 0.03, period_baseline_months: 12,
  source: 'test',
};
const POWER_LARGE = {
  ...POWER_MID, contract_value_min: 500_000_000, contract_value_max: null, rate_pm: 1.8,
};
const POWER_KSA = { ...POWER_MID, territory: 'KSA', rate_pm: 3.1 };
const CIVIL_MID = { ...POWER_MID, project_type: 'CIVIL', rate_pm: 1.9 };

const FACTORS = [
  { factor_kind: 'CONTRACTOR', factor_key: 'TIER_1', loading: -0.10, source: 'test' },
  { factor_kind: 'CONTRACTOR', factor_key: 'UNPROVEN', loading: 0.25, source: 'test' },
  { factor_kind: 'GROUND', factor_key: 'ALLUVIAL', loading: 0.15, source: 'test' },
  { factor_kind: 'WET_RISK', factor_key: 'TIDAL', loading: 0.30, source: 'test' },
];

const LOAD_RATES = [
  { load_kind: 'TESTING', load_key: 'DEFAULT', rate_pm: 0.4, per_unit: 'WEEK', source: 'test' },
  { load_kind: 'MAINTENANCE', load_key: 'EXTENDED', rate_pm: 0.05, per_unit: 'MONTH', source: 'test' },
  { load_kind: 'DSU', load_key: 'DEFAULT', rate_pm: 3.0, per_unit: 'FLAT', source: 'test' },
];

const RISK = { inception_date: '2026-01-01', expiry_date: '2028-01-01' };

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'PROJECT_WORKS',
  sum_insured: 200_000_000,
  exposure_detail: { project_type: 'POWER', ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  projectBaseRates: [POWER_MID, POWER_LARGE, POWER_KSA, CIVIL_MID],
  projectFactors: FACTORS,
  projectLoadRates: LOAD_RATES,
  ...o,
});

describe('readExposure', () => {
  it('takes the contract value from the section', () => {
    expect(readExposure(section(), RISK).contractValue).toBe(200_000_000);
  });

  it('takes the period from the risk dates when the detail does not state it', () => {
    expect(readExposure(section(), RISK).months).toBe(24);
  });

  it('lets the section override the period', () => {
    expect(readExposure(section({ period_months: 36 }), RISK).months).toBe(36);
  });

  it('reads the separately-covered periods and the DSU', () => {
    const e = readExposure(section({
      testing_weeks: 8, maintenance_months: 24, maintenance_type: 'extended',
      dsu_sum_insured: 60_000_000, dsu_indemnity_months: 12,
    }), RISK);
    expect(e.testingWeeks).toBe(8);
    expect(e.maintenanceMonths).toBe(24);
    expect(e.maintenanceType).toBe('EXTENDED');
    expect(e.dsuSumInsured).toBe(60_000_000);
  });

  it('defaults the earning pattern to straight-line and takes the risk\'s when set', () => {
    expect(readExposure(section(), RISK).earningPattern).toBe('STRAIGHT_LINE');
    expect(readExposure(section(), { ...RISK, earning_pattern: 'S_CURVE' }).earningPattern)
      .toBe('S_CURVE');
  });
});

describe('selectProjectRate', () => {
  const pool = [POWER_MID, POWER_LARGE, POWER_KSA, CIVIL_MID];

  it('picks the band the contract value falls in', () => {
    expect(selectProjectRate(pool, {
      projectType: 'POWER', territory: 'WORLDWIDE', contractValue: 200_000_000,
    }).rate).toBe(POWER_MID);
  });

  it('treats value bands as half-open', () => {
    expect(selectProjectRate(pool, {
      projectType: 'POWER', territory: 'WORLDWIDE', contractValue: 500_000_000,
    }).rate).toBe(POWER_LARGE);
  });

  it('prefers the territory-specific rate and flags a worldwide fallback', () => {
    expect(selectProjectRate(pool, {
      projectType: 'POWER', territory: 'KSA', contractValue: 200_000_000,
    }).rate).toBe(POWER_KSA);
    const fb = selectProjectRate(pool, {
      projectType: 'POWER', territory: 'EGYPT', contractValue: 200_000_000,
    });
    expect(fb.rate).toBe(POWER_MID);
    expect(fb.fellBackToWorldwide).toBe(true);
  });

  it('never crosses project type', () => {
    expect(selectProjectRate(pool, {
      projectType: 'TUNNEL', territory: 'WORLDWIDE', contractValue: 200_000_000,
    }).rate).toBeNull();
  });

  it('returns nothing below the lowest band rather than stretching it', () => {
    expect(selectProjectRate(pool, {
      projectType: 'POWER', territory: 'WORLDWIDE', contractValue: 1_000_000,
    }).rate).toBeNull();
  });
});

describe('resolveProjectFactors', () => {
  it('sums the loadings, because a construction slip builds up additively', () => {
    const { total, applied } = resolveProjectFactors(FACTORS, {
      CONTRACTOR: 'TIER_1', GROUND: 'ALLUVIAL', WET_RISK: 'TIDAL',
    });
    expect(total).toBeCloseTo(-0.10 + 0.15 + 0.30, 12);
    expect(Object.keys(applied)).toEqual(['CONTRACTOR', 'GROUND', 'WET_RISK']);
  });

  it('reports a selection with no loaded loading instead of inventing one', () => {
    const { total, missing } = resolveProjectFactors(FACTORS, { METHOD: 'TOP_DOWN' });
    expect(total).toBe(0);
    expect(missing).toEqual(['METHOD=TOP_DOWN']);
  });

  it('accepts lower-case keys from the exposure blob', () => {
    expect(resolveProjectFactors(FACTORS, { contractor: 'TIER_1' }).total).toBeCloseTo(-0.10, 12);
  });

  it('covers the kinds the factor table constrains itself to', () => {
    expect(FACTOR_KINDS).toEqual(
      ['CONTRACTOR', 'METHOD', 'GROUND', 'WET_RISK', 'PHASING', 'SECURITY'],
    );
    expect(LOAD_KINDS).toEqual(['TESTING', 'MAINTENANCE', 'DSU']);
  });
});

describe('loadCost', () => {
  it('multiplies a per-week rate by the weeks', () => {
    const r = loadCost(LOAD_RATES, { kind: 'TESTING', base: 100_000_000, units: 8 });
    expect(r.lossCost).toBeCloseTo((100_000_000 * 0.4) / 1000 * 8, 6);
  });

  it('ignores the units on a flat rate', () => {
    const r = loadCost(LOAD_RATES, { kind: 'DSU', base: 60_000_000, units: 99 });
    expect(r.lossCost).toBeCloseTo((60_000_000 * 3.0) / 1000, 6);
  });

  it('falls back to the DEFAULT key when the stated one is not loaded', () => {
    const r = loadCost(LOAD_RATES, { kind: 'DSU', key: 'HIGH_DELAY', base: 10_000_000 });
    expect(r.rate.load_key).toBe('DEFAULT');
  });

  it('returns nothing when the cover has duration but no duration is stated', () => {
    expect(loadCost(LOAD_RATES, { kind: 'TESTING', base: 100_000_000, units: null })).toBeNull();
  });

  it('returns nothing when no rate is loaded for the kind', () => {
    expect(loadCost([], { kind: 'TESTING', base: 100_000_000, units: 8 })).toBeNull();
  });
});

describe('projectLossCost', () => {
  const price = (detail = {}, risk = RISK, r = rates()) => projectLossCost({
    exposure: readExposure(section(detail), risk), rates: r,
  });

  it('rates the contract value over the whole period, with the period loading', () => {
    const out = price();
    expect(out.available).toBe(true);
    // 2.5‰ base, no factors, 24 months at 3%/month over a 12-month baseline
    // → period factor 1.36 → 3.40‰ on 200m.
    expect(out.diagnostics.period_factor).toBeCloseTo(1.36, 12);
    expect(out.diagnostics.works_rate_pm).toBeCloseTo(3.4, 12);
    expect(out.lossCost).toBeCloseTo((200_000_000 * 3.4) / 1000, 4);
  });

  it('applies the project factors additively to the base rate', () => {
    const out = price({ factors: { CONTRACTOR: 'UNPROVEN', GROUND: 'ALLUVIAL' } });
    // base 2.5 × (1 + 0.25 + 0.15) × 1.36
    expect(out.diagnostics.works_rate_pm).toBeCloseTo(2.5 * 1.40 * 1.36, 10);
  });

  it('adds testing, maintenance and DSU as their own lines', () => {
    const out = price({
      plant_value: 120_000_000, testing_weeks: 8,
      maintenance_months: 24, maintenance_type: 'EXTENDED',
      dsu_sum_insured: 60_000_000, dsu_indemnity_months: 12,
    });
    const kinds = out.diagnostics.extras.map((e) => e.kind);
    expect(kinds).toEqual(['TESTING', 'MAINTENANCE', 'DSU']);
    const testing = (120_000_000 * 0.4) / 1000 * 8;
    const maint = (200_000_000 * 0.05) / 1000 * 24;
    const dsu = (60_000_000 * 3.0) / 1000;
    expect(out.diagnostics.extras_loss_cost).toBeCloseTo(testing + maint + dsu, 4);
    expect(out.lossCost).toBeCloseTo(out.diagnostics.works_loss_cost + testing + maint + dsu, 4);
  });

  it('rates testing on the plant value when there is one, not the whole contract', () => {
    const withPlant = price({ plant_value: 120_000_000, testing_weeks: 8 });
    const without = price({ testing_weeks: 8 });
    expect(withPlant.diagnostics.extras[0].loss_cost)
      .toBeLessThan(without.diagnostics.extras[0].loss_cost);
  });

  it('says so when a long project has no period loading loaded', () => {
    const noPeriod = { ...POWER_MID, period_factor_per_month: null };
    const out = price({}, RISK, rates({ projectBaseRates: [noPeriod] }));
    expect(out.diagnostics.period_factor).toBe(1);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/understates a long project/i);
  });

  it('says so when DSU is stated but unrated', () => {
    const out = price(
      { dsu_sum_insured: 60_000_000, dsu_indemnity_months: 12 },
      RISK,
      rates({ projectLoadRates: [] }),
    );
    expect(out.diagnostics.warnings.join(' ')).toMatch(/delay cover.*not in this price/i);
  });

  it('records that the rate covers the period, so nothing downstream annualises it', () => {
    expect(price().diagnostics.period_basis_note).toMatch(/whole project period/i);
  });

  it('reports unavailable, with a reason, when no rate is loaded for the type', () => {
    const out = price({ project_type: 'TUNNEL' });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toContain('TUNNEL');
  });

  it('reports unavailable without a contract value or a project type', () => {
    expect(projectLossCost({
      exposure: readExposure(section({}, { sum_insured: null }), RISK), rates: rates(),
    }).unavailableReason).toMatch(/contract value/i);
    expect(price({ project_type: null }).unavailableReason).toMatch(/project type/i);
  });

  it('warns when it has no project period at all', () => {
    const out = price({}, { policy_period_months: null });
    expect(out.diagnostics.warnings.join(' ')).toMatch(/no project period/i);
  });
});

describe('computeCandidates and the descriptor', () => {
  it('offers the project rate as the exposure candidate', () => {
    const c = computeCandidates({ risk: RISK, section: section(), rates: rates() });
    expect(c.map((x) => x.code)).toEqual(['PROJECT_RATE']);
    expect(c[0].result.available).toBe(true);
  });

  it('rates on contract value over a project period, not annually', () => {
    expect(projectWorks.ratingBasis).toBe('CONTRACT_VALUE');
    expect(projectWorks.periodBasis).toBe('PROJECT');
    expect(projectWorks.implemented).toBe(true);
  });

  it('caps credibility low — a project has no experience of its own', () => {
    expect(projectWorks.credibility.maxZ).toBe(0.50);
  });
});
