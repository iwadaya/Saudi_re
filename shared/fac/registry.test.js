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
