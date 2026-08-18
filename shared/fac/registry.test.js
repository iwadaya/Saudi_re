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
    const blocker = pricingBlocker(getFamily('AVIATION_HULL'), {});
    expect(blocker.reason).toBe('NOT_IMPLEMENTED');
    expect(blocker.message).toMatch(/per mille of agreed value/i);
    expect(blocker.message).toMatch(/Phase 5/);
  });

  it('does not block any family the class taxonomy actually maps to', () => {
    for (const code of [
      'LIABILITY_LIMIT', 'MARINE_LIABILITY', 'HULL_VALUE', 'TRANSIT_VALUES',
      'PROJECT_WORKS', 'PLANT_OPERATIONAL', 'ENERGY_ASSET', 'CYBER_LIMIT',
      'MOTOR_FLEET', 'PA_BENEFIT',
    ]) {
      expect(pricingBlocker(getFamily(code), {})).toBeNull();
    }
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

  it('returns a blocker instead of throwing for a family with no engine', () => {
    // The old path handed every risk to the property engine, which threw
    // "Unknown occupancy_code", and the screen printed the exception.
    const out = priceFacRisk({
      risk: { insured_name: 'Example Airline' },
      cob: { rating_family: 'AVIATION_HULL' },
      inputs: {}, referenceData: REFERENCE,
    });
    expect(out.ok).toBe(false);
    expect(out.family).toBe('AVIATION_HULL');
    expect(out.blocker.reason).toBe('NOT_IMPLEMENTED');
    expect(out.blocker.message).toMatch(/agreed value/i);
  });

  it('resolves a hull risk to its own family without touching the property engine', () => {
    const out = priceFacRisk({
      risk: { insured_name: 'MV Example' },
      cob: { rating_family: 'HULL_VALUE' },
      inputs: {}, referenceData: REFERENCE,
    });
    expect(out.ok).toBe(true);
    expect(out.family).toBe('HULL_VALUE');
    // A family that rates off loaded tables has no workbook-style quote.
    expect(out.result).toBeNull();
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
      risk: { insured_name: 'Example Airline' }, cob: { rating_family: 'AVIATION_HULL' },
      inputs: {}, referenceData: REFERENCE,
    });
    expect(out.ok).toBe(false);
    expect(out.technical).toBeNull();
    expect(out.blocker.reason).toBe('NOT_IMPLEMENTED');
  });

  // ── Phase 3: the pipeline no longer knows which family it is holding ──

  it('prices a casualty risk off its own family, against turnover not sum insured', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull({
      risk: { insured_name: 'Example Manufacturing', pd_sum_insured: 0 },
      cob: { rating_family: 'LIABILITY_LIMIT', fac_cob_id: 41 },
      sections: [{
        section_no: 1, fac_cob_id: 41, rating_family: 'LIABILITY_LIMIT',
        exposure_base: 250_000_000, exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
        attachment: 0, exposure_detail: {},
      }],
      inputs: {}, referenceData: REFERENCE,
      rates: {
        liabilityBaseRates: [{
          fac_cob_id: 41, territory: 'WORLDWIDE', basis_unit: 'TURNOVER',
          basis_divisor: 1_000_000, basic_limit: 1_000_000, loss_cost_per_unit: 400,
        }],
        ilfCurves: [{
          curve_code: 'GL-WW', kind: 'POWER', territory: 'WORLDWIDE',
          basic_limit: 1_000_000, params: { doubling_loading: 0.20 },
        }],
      },
    });
    expect(out.ok).toBe(true);
    const ilf = out.technical.candidates.find((c) => c.code === 'ILF_CURVE');
    expect(ilf.available).toBe(true);
    // The premium base is the turnover, not a sum insured of zero.
    expect(out.technical.premiums.expectedLoss).toBeCloseTo(100_000 * 5 ** Math.log2(1.2), 4);
  });

  it('prices a cargo risk and keeps war beside the blend, not inside it', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const args = (warRegion) => ({
      risk: { insured_name: 'Example Shipper' },
      cob: { rating_family: 'TRANSIT_VALUES' },
      sections: [{
        section_no: 1, rating_family: 'TRANSIT_VALUES', exposure_base: 100_000_000,
        limit_amount: 5_000_000,
        exposure_detail: {
          commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE',
          ...(warRegion ? { war_region: warRegion } : {}),
        },
      }],
      inputs: {}, referenceData: REFERENCE,
      rates: {
        transitRates: [{
          commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE', rate_pm: 0.6,
        }],
        warRates: [{
          region: 'ARABIAN_GULF', basis: 'ANNUAL', rate_pm: 0.75, effective_from: '2026-06-01',
        }],
      },
    });
    const plain = priceFacRiskFull(args(null));
    const withWar = priceFacRiskFull(args('ARABIAN_GULF'));

    expect(plain.technical.blendedLossCostPm).toBeCloseTo(0.6, 9);
    // The blend is unchanged by the war section; the war rate is added on top.
    expect(withWar.technical.blendedLossCostPm).toBeCloseTo(0.6, 9);
    expect(withWar.technical.additiveLoadPm).toBeCloseTo(0.75, 9);
    expect(withWar.technical.expectedLossPm).toBeCloseTo(1.35, 9);
    expect(withWar.technical.additiveSections[0].code).toBe('WAR_SECTION');
  });

  it('prices a hull risk per mille of the agreed value', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull({
      risk: { insured_name: 'MV Example', period_from: '2026-01-01' },
      cob: { rating_family: 'HULL_VALUE' },
      sections: [{
        section_no: 1, rating_family: 'HULL_VALUE', sum_insured: 30_000_000,
        exposure_detail: { vessel_type: 'BULK_CARRIER', tonnage: 45_000 },
      }],
      inputs: {}, referenceData: REFERENCE,
      rates: {
        hullRates: [{
          vessel_type: 'BULK_CARRIER', tonnage_min: 20_000, tonnage_max: 80_000, rate_pm: 3.5,
        }],
        hullFactors: [],
      },
    });
    expect(out.ok).toBe(true);
    expect(out.technical.blendedLossCostPm).toBeCloseTo(3.5, 9);
    expect(out.technical.premiums.expectedLoss).toBeCloseTo((30_000_000 * 3.5) / 1000, 4);
  });

  // ── Phase 4: a risk is priced across every family its sections use ──

  const LIABILITY_RATES = {
    liabilityBaseRates: [{
      territory: 'WORLDWIDE', basis_unit: 'TURNOVER', basis_divisor: 1_000_000,
      basic_limit: 1_000_000, loss_cost_per_unit: 400,
    }],
    ilfCurves: [{
      curve_code: 'GL-WW', kind: 'POWER', family_code: 'LIABILITY_LIMIT',
      territory: 'WORLDWIDE', basic_limit: 1_000_000, params: { doubling_loading: 0.20 },
    }],
  };

  const twoFamilyRisk = (overrides = {}) => ({
    risk: { ...RISK, pd_sum_insured: 0, bi_sum_insured: 0 },
    cob: COB,
    sections: [
      {
        section_no: 1, section_id: 'sec-prop', rating_family: 'SCHEDULE_PROPERTY',
        sum_insured: 100_000_000,
      },
      {
        section_no: 2, section_id: 'sec-liab', rating_family: 'LIABILITY_LIMIT',
        exposure_base: 250_000_000, exposure_unit: 'TURNOVER', limit_amount: 5_000_000,
      },
    ],
    inputs: INPUTS, referenceData: REFERENCE, rates: LIABILITY_RATES,
    ...overrides,
  });

  it('prices every section group, not just the primary one', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull(twoFamilyRisk());
    expect(out.sections).toHaveLength(2);
    expect(out.sections.map((s) => s.family))
      .toEqual(['SCHEDULE_PROPERTY', 'LIABILITY_LIMIT']);
    for (const group of out.sections) {
      expect(group.loss_cost).toBeGreaterThan(0);
    }
  });

  it('gives each group its own premium base rather than one sum insured', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull(twoFamilyRisk());
    const [property, liability] = out.sections;
    // Property rates against values; casualty against turnover. Using the
    // sum insured for both was the Phase 3 shortcut.
    expect(property.premium_base).toBe(100_000_000);
    expect(liability.premium_base).toBe(250_000_000);
    expect(property.rating_basis).toBe('SI_PER_MILLE');
    expect(liability.rating_basis).toBe('LIMIT_ILF');
  });

  it('sums the sections in money, because their rates are not addable', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull(twoFamilyRisk());
    const total = out.sections.reduce((t, s) => t + s.loss_cost, 0);
    expect(out.technical.premiums.expectedLoss).toBeCloseTo(total, 4);
    expect(out.technical.multiSection).toBe(true);
  });

  it('says the blended rate is a scaling figure, not a quoted rate', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull(twoFamilyRisk());
    expect(out.technical.warnings.join(' ')).toMatch(/scaling figure rather than a rate/i);
    expect(out.technical.warnings.join(' ')).toMatch(/SCHEDULE_PROPERTY, LIABILITY_LIMIT/);
  });

  it('credits experience on the family carrying the most exposure', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const out = priceFacRiskFull(twoFamilyRisk());
    // 250m turnover against 100m of values — casualty carries more base.
    expect(out.technical.credibilityFamily).toBe('LIABILITY_LIMIT');
  });

  it('sends a loss tagged to a section into that section only', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const losses = [
      { loss_year: 2025, section_id: 'sec-liab', fgu_incurred: 900_000, is_open: false },
    ];
    const out = priceFacRiskFull(twoFamilyRisk({ losses }));
    const liability = out.sections.find((s) => s.family === 'LIABILITY_LIMIT');
    const property = out.sections.find((s) => s.family === 'SCHEDULE_PROPERTY');
    expect(liability.candidates.some((c) => c.code === 'BURNING_COST')).toBe(true);
    expect(property.candidates.some((c) => c.code === 'BURNING_COST')).toBe(false);
  });

  it('keeps an untagged loss at risk level, blended against the sections combined', async () => {
    const { priceFacRiskFull } = await import('./index.js');
    const losses = Array.from({ length: 5 }, (_, i) => ({
      loss_year: 2021 + i, fgu_incurred: 400_000, is_open: false,
    }));
    const experienceBasis = Array.from({ length: 5 }, (_, i) => ({
      loss_year: 2021 + i, exposure_base: 350_000_000,
    }));
    const out = priceFacRiskFull(twoFamilyRisk({ losses, experienceBasis }));
    const burn = out.technical.candidates.find((c) => c.code === 'BURNING_COST');
    const total = out.technical.candidates.find((c) => c.code === 'SECTION_TOTAL');
    expect(burn.available).toBe(true);
    // Both are per mille of the same denominator, or the blend would be
    // averaging numbers measured against different things.
    expect(out.technical.weights.BURNING_COST).toBeGreaterThan(0);
    expect(out.technical.weights.SECTION_TOTAL).toBeGreaterThan(0);
    expect(total.available).toBe(true);
  });

  it('leaves a single-section risk on exactly its old answer', async () => {
    const { priceFacRiskFull, priceFacRisk } = await import('./index.js');
    const before = priceFacRisk({ risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE });
    const after = priceFacRiskFull({ risk: RISK, cob: COB, inputs: INPUTS, referenceData: REFERENCE });
    expect(after.technical.technicalGrossPm).toBeCloseTo(before.result.final_gross_rate_pm, 9);
    expect(after.technical.multiSection).toBeUndefined();
    expect(after.sections).toHaveLength(1);
  });
});
