import { describe, it, expect } from 'vitest';
import {
  getFamily, listFamilies, familyForClass, familiesForClasses,
  wizardStepsForFamilies, pricingBlocker, RATING_BASIS_LABEL, DEFAULT_FAMILY_CODE,
} from './registry.js';
import { priceFacRisk } from './index.js';

describe('registry shape', () => {
  it('declares every family in the design, with SCHEDULE_PROPERTY implemented', () => {
    const codes = listFamilies().map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining([
      'SCHEDULE_PROPERTY', 'PROJECT_WORKS', 'PLANT_OPERATIONAL', 'HULL_VALUE',
      'TRANSIT_VALUES', 'MARINE_LIABILITY', 'ENERGY_ASSET', 'LIABILITY_LIMIT',
      'MOTOR_FLEET', 'CYBER_LIMIT', 'PA_BENEFIT',
    ]));
    expect(getFamily('SCHEDULE_PROPERTY').implemented).toBe(true);
    expect(listFamilies()[0].implemented).toBe(true);
  });

  it('gives every family a rating basis that has a label', () => {
    for (const family of listFamilies()) {
      expect(RATING_BASIS_LABEL[family.ratingBasis]).toBeTruthy();
    }
  });

  it('is case-insensitive and safe on junk input', () => {
    expect(getFamily('schedule_property').code).toBe('SCHEDULE_PROPERTY');
    expect(getFamily(null)).toBeNull();
    expect(getFamily('NOPE')).toBeNull();
  });
});

describe('familyForClass', () => {
  it('resolves the family named on the class row', () => {
    expect(familyForClass({ rating_family: 'HULL_VALUE' }).code).toBe('HULL_VALUE');
  });

  it('falls back to schedule property for an unmapped class', () => {
    // Which is exactly what the single engine already did to every class
    // before the taxonomy existed — so this is not a behaviour change.
    expect(familyForClass({}).code).toBe(DEFAULT_FAMILY_CODE);
    expect(familyForClass(null).code).toBe(DEFAULT_FAMILY_CODE);
  });

  it('collects the distinct families across a multi-section risk', () => {
    const families = familiesForClasses([
      { rating_family: 'PROJECT_WORKS' },
      { rating_family: 'LIABILITY_LIMIT' },
      { rating_family: 'PROJECT_WORKS' },
    ]);
    expect(families.map((f) => f.code)).toEqual(['PROJECT_WORKS', 'LIABILITY_LIMIT']);
  });
});

describe('wizardStepsForFamilies', () => {
  it('asks for a COPE survey on property and not on cyber', () => {
    const property = wizardStepsForFamilies([getFamily('SCHEDULE_PROPERTY')]);
    expect(property.has('FAC_COPE')).toBe(true);
    expect(property.has('FAC_LOCATIONS')).toBe(true);

    const cyber = wizardStepsForFamilies([getFamily('CYBER_LIMIT')]);
    expect(cyber.has('FAC_COPE')).toBe(false);
  });

  it('unions the steps a multi-family risk needs', () => {
    const steps = wizardStepsForFamilies([
      getFamily('CYBER_LIMIT'), getFamily('SCHEDULE_PROPERTY'),
    ]);
    expect([...steps].sort()).toEqual(['FAC_COPE', 'FAC_LOCATIONS']);
  });
});

describe('pricingBlocker — an unbuilt family is a state, not a crash (F1)', () => {
  it('explains what a declared-but-unimplemented family rates on', () => {
    const blocker = pricingBlocker(getFamily('LIABILITY_LIMIT'), {});
    expect(blocker.reason).toBe('NOT_IMPLEMENTED');
    expect(blocker.message).toMatch(/increased limit factors/i);
    expect(blocker.message).toMatch(/Phase 3/);
  });

  it('names the missing inputs an implemented family needs', () => {
    const blocker = pricingBlocker(getFamily('SCHEDULE_PROPERTY'), { occupancy_code: 102 });
    expect(blocker.reason).toBe('MISSING_INPUT');
    expect(blocker.missing).toEqual(['risk_country_zone']);
    expect(blocker.message).toMatch(/Risk Detail/);
  });

  it('returns null when the family can price', () => {
    expect(pricingBlocker(getFamily('SCHEDULE_PROPERTY'), {
      occupancy_code: 102, risk_country_zone: 'KSA - Whole Country',
    })).toBeNull();
  });
});

describe('priceFacRisk', () => {
  const REFERENCE = {
    occupancies: [{ occupancy_code: 1, hazard_grade: 2, frequency_category: 1, flexa_base_rate_pm: 0.25 }],
    factors: [],
    factorWeights: { WITHOUT_BI: {} },
    hazardGradeScore: [{ hazard_grade: 2, score: 97 }],
    frequencyScore: [{ frequency_category: 1, score: 100 }],
    capacityBands: [],
    territorialCapacity: [],
    biIndemnity: {},
    natcatRates: [{ country_zone: 'Z1', flood_storm_rate: 0.03, earthquake_rate: 0.015 }],
  };

  it('returns a blocker instead of throwing for a marine risk', () => {
    // The old path handed a hull risk to the property engine, which threw
    // "Unknown occupancy_code", and the screen printed the exception.
    const out = priceFacRisk({
      risk: { insured_name: 'MV Example' },
      cob: { rating_family: 'HULL_VALUE' },
      inputs: {}, referenceData: REFERENCE,
    });
    expect(out.ok).toBe(false);
    expect(out.family).toBe('HULL_VALUE');
    expect(out.blocker.reason).toBe('NOT_IMPLEMENTED');
    expect(out.blocker.message).toMatch(/agreed value/i);
  });

  it('returns a blocker for a property risk missing its NatCat zone', () => {
    const out = priceFacRisk({
      risk: { occupancy_code: 1 },
      cob: { rating_family: 'SCHEDULE_PROPERTY' },
      inputs: {}, referenceData: REFERENCE,
    });
    expect(out.ok).toBe(false);
    expect(out.blocker.reason).toBe('MISSING_INPUT');
  });

  it('prices a property risk and attaches the exposure profile it used', () => {
    const out = priceFacRisk({
      risk: { occupancy_code: 1, risk_country_zone: 'Z1', pd_sum_insured: 1_000_000, bi_sum_insured: 0 },
      cob: { rating_family: 'SCHEDULE_PROPERTY' },
      inputs: { occupancy_code: 1, country_zone: 'Z1', commission_pct: 0.2 },
      referenceData: REFERENCE,
    });
    expect(out.ok).toBe(true);
    expect(out.family).toBe('SCHEDULE_PROPERTY');
    expect(out.exposure.basis).toBe('RISK_HEADER');
    expect(out.result.total_rate_pm).toBeCloseTo(0.25 + 0.03 + 0.015, 9);
    expect(out.result.premiums.sum_insured).toBe(1_000_000);
    expect(out.result.exposure_basis).toBe('RISK_HEADER');
  });
});

describe('priceFacRiskFull — the whole pipeline', () => {
  const REFERENCE = {
    occupancies: [{ occupancy_code: 1, hazard_grade: 2, frequency_category: 1, flexa_base_rate_pm: 1.0 }],
    factors: [],
    factorWeights: { WITHOUT_BI: {} },
    hazardGradeScore: [{ hazard_grade: 2, score: 97 }],
    frequencyScore: [{ frequency_category: 1, score: 100 }],
    capacityBands: [],
    territorialCapacity: [],
    biIndemnity: {},
    natcatRates: [{ country_zone: 'Z1', flood_storm_rate: 0, earthquake_rate: 0 }],
  };
  const RISK = {
    occupancy_code: 1, risk_country_zone: 'Z1', uw_year: 2026,
    pd_sum_insured: 100_000_000, bi_sum_insured: 0,
  };
  const COB = { rating_family: 'SCHEDULE_PROPERTY' };
  const INPUTS = { occupancy_code: 1, country_zone: 'Z1', commission_pct: 0.2, margin_pct: 0.05 };

  it('reproduces the engine exactly when no Phase 2 data exists', async () => {
    // The invariant that makes this safe to put in front of the existing
    // property engine: no history, no curve, no loads ⇒ same number.
    const { priceFacRiskFull, priceFacRisk } = await import('./index.js');
    const before = priceFacRisk({ risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE });
    const after = priceFacRiskFull({ risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE });

    expect(after.ok).toBe(true);
    expect(after.technical.priced).toBe(true);
    expect(after.technical.weights).toEqual({ WORKBOOK_RATE: 1 });
    expect(after.technical.technicalGrossPm).toBeCloseTo(before.result.final_gross_rate_pm, 10);
  });

  it('blends in the burning cost once there is history to blend', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull({
      risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE,
      losses: Array.from({ length: 6 }, (_, i) => ({
        loss_year: 2021 + i, fgu_paid: 200_000, is_open: false,
      })),
      experienceBasis: Array.from({ length: 6 }, (_, i) => ({
        loss_year: 2021 + i, exposure_base: 100_000_000,
      })),
    });
    const burn = out.technical.candidates.find((c) => c.code === 'BURNING_COST');
    expect(burn.available).toBe(true);
    expect(burn.ratePm).toBeCloseTo(2.0, 9);          // 200k / 100m × 1000
    // SCHEDULE_PROPERTY: k = 6, so 6 claims gives Z = 0.5, capped at 0.80.
    expect(out.technical.credibility.z).toBeCloseTo(0.5, 9);
    expect(out.technical.weights.BURNING_COST).toBeCloseTo(0.5, 9);
    expect(out.technical.weights.WORKBOOK_RATE).toBeCloseTo(0.5, 9);
  });

  it('reports the exposure curve as unavailable when no curve is configured', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull({ risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE });
    const curve = out.technical.candidates.find((c) => c.code === 'EXPOSURE_CURVE');
    expect(curve.available).toBe(false);
    expect(curve.unavailableReason).toBeTruthy();
    expect(out.technical.weights.EXPOSURE_CURVE).toBeUndefined();
  });

  it('exposure-rates once a curve is configured for the size band', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const linear = { kind: 'TABULATED', curve_code: 'LINEAR', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    const out = priceFacRiskFull({
      risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE,
      curveBands: [{ min_exposure: 0, max_exposure: null, curve: linear }],
    });
    const curve = out.technical.candidates.find((c) => c.code === 'EXPOSURE_CURVE');
    expect(curve.available).toBe(true);
    // Ground-up unlimited under G(x)=x: the whole technical rate, 1.0‰.
    expect(curve.ratePm).toBeCloseTo(1.0, 9);
    expect(out.technical.weights.EXPOSURE_CURVE).toBeCloseTo(0.5, 9);
    expect(out.technical.weights.WORKBOOK_RATE).toBeCloseTo(0.5, 9);
  });

  it('shows a benchmark alongside without letting it move the price', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull({
      risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE,
      benchmarks: [{ rate_pm: 9 }, { rate_pm: 11 }], benchmarkScope: 'GCC · IAR',
    });
    const bm = out.technical.candidates.find((c) => c.code === 'BENCHMARK');
    expect(bm.available).toBe(true);
    expect(bm.ratePm).toBeCloseTo(10, 9);
    expect(out.technical.weights.BENCHMARK).toBeUndefined();
    expect(out.technical.blendedLossCostPm).toBeCloseTo(1.0, 9);
  });

  it('prices an excess placement below the ground-up cost', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const losses = Array.from({ length: 6 }, (_, i) => ({
      loss_year: 2021 + i, fgu_paid: 200_000, is_open: false,
    }));
    const experienceBasis = Array.from({ length: 6 }, (_, i) => ({
      loss_year: 2021 + i, exposure_base: 100_000_000,
    }));
    const out = priceFacRiskFull({
      risk: { ...RISK, placement_type: 'NON_PROPORTIONAL', np_retention: 500_000, np_limit: 1_000_000 },
      cob: COB, inputs: INPUTS, referenceData: REFERENCE, losses, experienceBasis,
    });
    const burn = out.technical.candidates.find((c) => c.code === 'BURNING_COST');
    // Every loss is 200k, none reaches a 500k attachment.
    expect(burn.ratePm).toBe(0);
    expect(burn.claimCount).toBe(0);
  });

  it('still returns the blocker for a family with no engine', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull({
      risk: { insured_name: 'MV Example' }, cob: { rating_family: 'HULL_VALUE' },
      inputs: {}, referenceData: REFERENCE,
    });
    expect(out.ok).toBe(false);
    expect(out.technical).toBeNull();
    expect(out.blocker.reason).toBe('NOT_IMPLEMENTED');
  });
});
