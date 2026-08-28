import { describe, it, expect } from 'vitest';
import {
  readExposure, selectBaseRate, selectIlfCurve, computeCandidates,
  BASIS_UNITS, FAMILY_CODE, liabilityLimit, marineLiability,
} from './liabilityLimit.js';

// ────────────────────────────────────────────────────────────────────────────
// Reference data. Every one of these rows is a fixture, not a shipped rate —
// the tables in migration 136 are deliberately empty (design doc §8).
// ────────────────────────────────────────────────────────────────────────────

const TURNOVER_RATE_WW = {
  fac_cob_id: 41,
  territory: 'WORLDWIDE',
  basis_unit: 'TURNOVER',
  basis_divisor: 1_000_000,
  basic_limit: 1_000_000,
  loss_cost_per_unit: 400,
};
const TURNOVER_RATE_US = {
  ...TURNOVER_RATE_WW, territory: 'USA', loss_cost_per_unit: 1_800,
};
const PAYROLL_RATE_WW = {
  ...TURNOVER_RATE_WW, basis_unit: 'PAYROLL', loss_cost_per_unit: 900,
};

const POWER_CURVE_WW = {
  curve_code: 'GL-WW-POWER',
  kind: 'POWER',
  territory: 'WORLDWIDE',
  basic_limit: 1_000_000,
  params: { doubling_loading: 0.20 },
};
const POWER_CURVE_US = {
  ...POWER_CURVE_WW, curve_code: 'GL-US-POWER', territory: 'USA',
  params: { doubling_loading: 0.35 },
};

const section = (overrides = {}) => ({
  section_no: 1,
  fac_cob_id: 41,
  rating_family: FAMILY_CODE,
  exposure_base: 250_000_000,
  exposure_unit: 'TURNOVER',
  limit_amount: 5_000_000,
  attachment: 0,
  exposure_detail: {},
  ...overrides,
});

const rates = (overrides = {}) => ({
  liabilityBaseRates: [TURNOVER_RATE_WW, TURNOVER_RATE_US, PAYROLL_RATE_WW],
  ilfCurves: [POWER_CURVE_WW, POWER_CURVE_US],
  ...overrides,
});

// ────────────────────────────────────────────────────────────────────────────

describe('readExposure', () => {
  it('reads the exposure off the section columns', () => {
    const e = readExposure(section());
    expect(e.exposureBase).toBe(250_000_000);
    expect(e.basisUnit).toBe('TURNOVER');
    expect(e.limit).toBe(5_000_000);
    expect(e.attachment).toBe(0);
    expect(e.warnings).toEqual([]);
  });

  it('falls back to exposure_detail when the columns are empty', () => {
    const e = readExposure(section({
      exposure_base: null,
      exposure_unit: null,
      limit_amount: null,
      attachment: null,
      exposure_detail: { exposure_base: 40_000_000, basis_unit: 'payroll', limit: 2_000_000, attachment: 1_000_000 },
    }));
    expect(e.exposureBase).toBe(40_000_000);
    expect(e.basisUnit).toBe('PAYROLL');
    expect(e.limit).toBe(2_000_000);
    expect(e.attachment).toBe(1_000_000);
  });

  it('defaults the territory to worldwide and reads it back upper-cased', () => {
    expect(readExposure(section()).territory).toBe('WORLDWIDE');
    expect(readExposure(section({ exposure_detail: { territory: 'usa' } })).territory).toBe('USA');
  });

  it('reads the cover-shape flags out of exposure_detail', () => {
    const e = readExposure(section({
      exposure_detail: {
        claims_made: true,
        retro_years: 3,
        defence_costs_in_addition: true,
        aggregate_limit: 10_000_000,
        aggregate_reinstatements: 1,
      },
    }));
    expect(e.claimsMade).toBe(true);
    expect(e.retroYears).toBe(3);
    expect(e.defenceCostsInAddition).toBe(true);
    expect(e.aggregateLimit).toBe(10_000_000);
    expect(e.aggregateReinstatements).toBe(1);
  });

  it('treats absent flags as false rather than unknown', () => {
    const e = readExposure(section());
    expect(e.claimsMade).toBe(false);
    expect(e.defenceCostsInAddition).toBe(false);
    expect(e.retroYears).toBeNull();
    expect(e.aggregateReinstatements).toBeNull();
  });

  it('warns when the section rates on a unit this family does not know', () => {
    const e = readExposure(section({ exposure_unit: 'SUM_INSURED' }));
    expect(e.basisUnit).toBe('SUM_INSURED');
    expect(e.warnings).toHaveLength(1);
    expect(e.warnings[0]).toContain('SUM_INSURED');
  });

  it('survives a missing section', () => {
    const e = readExposure(null);
    expect(e.exposureBase).toBeNull();
    expect(e.basisUnit).toBeNull();
    expect(e.attachment).toBe(0);
  });

  it('lists exactly the units the base-rate table constrains itself to', () => {
    expect(BASIS_UNITS).toEqual(['TURNOVER', 'PAYROLL', 'FEE_INCOME', 'UNITS']);
  });
});

describe('selectBaseRate', () => {
  const pool = [TURNOVER_RATE_WW, TURNOVER_RATE_US, PAYROLL_RATE_WW];

  it('prefers the territory-specific rate', () => {
    const { rate, fellBackToWorldwide } = selectBaseRate(pool, {
      facCobId: 41, territory: 'USA', basisUnit: 'TURNOVER',
    });
    expect(rate).toBe(TURNOVER_RATE_US);
    expect(fellBackToWorldwide).toBe(false);
  });

  it('falls back to worldwide and says so', () => {
    const { rate, fellBackToWorldwide } = selectBaseRate(pool, {
      facCobId: 41, territory: 'CANADA', basisUnit: 'TURNOVER',
    });
    expect(rate).toBe(TURNOVER_RATE_WW);
    expect(fellBackToWorldwide).toBe(true);
  });

  it('never crosses basis units when picking', () => {
    const { rate } = selectBaseRate(pool, {
      facCobId: 41, territory: 'USA', basisUnit: 'PAYROLL',
    });
    // There is no US payroll rate; the worldwide PAYROLL one is the fallback,
    // and the US TURNOVER one must not be reached for it.
    expect(rate).toBe(PAYROLL_RATE_WW);
  });

  it('reports which units the class does hold, so a mismatch can be named', () => {
    const { unitsAvailable } = selectBaseRate(pool, {
      facCobId: 41, territory: 'USA', basisUnit: 'FEE_INCOME',
    });
    expect(unitsAvailable).toEqual(['TURNOVER', 'PAYROLL']);
  });

  it('returns nothing when the class has no rate at all', () => {
    const { rate, fellBackToWorldwide } = selectBaseRate(pool, {
      facCobId: 41, territory: 'USA', basisUnit: 'FEE_INCOME',
    });
    expect(rate).toBeNull();
    expect(fellBackToWorldwide).toBe(false);
  });

  it('does not match another class of business', () => {
    const { rate } = selectBaseRate(pool, {
      facCobId: 99, territory: 'WORLDWIDE', basisUnit: 'TURNOVER',
    });
    expect(rate).toBeNull();
  });

  it('handles an empty table', () => {
    expect(selectBaseRate([], { facCobId: 41, territory: 'USA', basisUnit: 'TURNOVER' }).rate).toBeNull();
    expect(selectBaseRate(null, { facCobId: 41, territory: 'USA', basisUnit: 'TURNOVER' }).rate).toBeNull();
  });
});

describe('selectIlfCurve', () => {
  it('prefers the territory-specific curve', () => {
    expect(selectIlfCurve([POWER_CURVE_WW, POWER_CURVE_US], { territory: 'USA' })).toBe(POWER_CURVE_US);
  });

  it('falls back to the worldwide curve', () => {
    expect(selectIlfCurve([POWER_CURVE_WW, POWER_CURVE_US], { territory: 'KENYA' })).toBe(POWER_CURVE_WW);
  });

  it('returns null when nothing is loaded', () => {
    expect(selectIlfCurve([], { territory: 'USA' })).toBeNull();
    expect(selectIlfCurve(null, { territory: 'USA' })).toBeNull();
  });

  it('prefers a curve a family owns over a general-purpose one', () => {
    const marine = { ...POWER_CURVE_WW, curve_code: 'MAR-WW', family_code: 'MARINE_LIABILITY' };
    expect(selectIlfCurve([POWER_CURVE_WW, marine], {
      territory: 'WORLDWIDE', familyCode: 'MARINE_LIABILITY',
    })).toBe(marine);
  });

  it('never hands a curve owned by another family to this one', () => {
    const marine = { ...POWER_CURVE_WW, curve_code: 'MAR-WW', family_code: 'MARINE_LIABILITY' };
    expect(selectIlfCurve([marine], {
      territory: 'WORLDWIDE', familyCode: 'LIABILITY_LIMIT',
    })).toBeNull();
  });

  it('falls back to a general-purpose curve when the family owns none', () => {
    expect(selectIlfCurve([POWER_CURVE_WW], {
      territory: 'WORLDWIDE', familyCode: 'MARINE_LIABILITY',
    })).toBe(POWER_CURVE_WW);
  });
});

describe('marine liability', () => {
  it('shares the engine but takes the marine curve', () => {
    const marine = {
      ...POWER_CURVE_WW, curve_code: 'MAR-WW', family_code: 'MARINE_LIABILITY',
      params: { doubling_loading: 0.30 },
    };
    const [candidate] = marineLiability.computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section(),
      structure: {},
      rates: rates({ ilfCurves: [POWER_CURVE_WW, marine] }),
    });
    expect(candidate.result.diagnostics.curve).toBe('MAR-WW');
    expect(candidate.result.lossCost).toBeCloseTo(100_000 * 5 ** Math.log2(1.30), 6);
  });

  it('is the same family under a marine label', () => {
    expect(marineLiability.code).toBe('MARINE_LIABILITY');
    expect(marineLiability.segment).toBe('MARINE_TRANSIT');
    expect(marineLiability.ratingBasis).toBe('LIMIT_ILF');
    expect(marineLiability.implemented).toBe(true);
  });
});

describe('computeCandidates', () => {
  it('prices a primary limit off the basic-limit loss cost and the curve', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section(),
      structure: {},
      rates: rates(),
    });
    expect(candidate.code).toBe('ILF_CURVE');
    expect(candidate.result.available).toBe(true);

    // 250m turnover ÷ 1m × 400 = 100,000 at the 1m basic limit.
    // ILF(5m) = 5^log₂(1.2) = 5^0.263034 ≈ 1.5188.
    const alpha = Math.log2(1.2);
    const expected = 100_000 * 5 ** alpha;
    expect(candidate.result.lossCost).toBeCloseTo(expected, 6);
    expect(candidate.result.diagnostics.basic_limit_loss_cost).toBe(100_000);
    expect(candidate.result.diagnostics.curve).toBe('GL-WW-POWER');
  });

  it('prices an excess layer as the difference of two ILFs', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section(),
      structure: { attachment: 5_000_000, limit: 5_000_000 },
      rates: rates(),
    });
    const alpha = Math.log2(1.2);
    const expected = 100_000 * (10 ** alpha - 5 ** alpha);
    expect(candidate.result.lossCost).toBeCloseTo(expected, 6);
    expect(candidate.result.diagnostics.attachment).toBe(5_000_000);
    expect(candidate.result.diagnostics.limit).toBe(5_000_000);
  });

  it('lets the placement structure override the section limit', () => {
    const base = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: {}, rates: rates(),
    })[0].result.lossCost;
    const wider = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: { limit: 20_000_000 }, rates: rates(),
    })[0].result.lossCost;
    expect(wider).toBeGreaterThan(base);
  });

  it('uses the US curve and US rate for a US-exposed section', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_detail: { territory: 'USA' } }),
      structure: {},
      rates: rates(),
    });
    expect(candidate.result.diagnostics.curve).toBe('GL-US-POWER');
    expect(candidate.result.diagnostics.territory).toBe('USA');
    expect(candidate.result.diagnostics.territory_fallback).toBe(false);
    // 250m ÷ 1m × 1,800 = 450,000 at basic limit, α = log₂(1.35).
    expect(candidate.result.diagnostics.basic_limit_loss_cost).toBe(450_000);
    expect(candidate.result.lossCost).toBeCloseTo(450_000 * 5 ** Math.log2(1.35), 6);
  });

  it('flags a worldwide fallback rather than using it silently', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_detail: { territory: 'CANADA' } }),
      structure: {},
      rates: rates(),
    });
    expect(candidate.result.available).toBe(true);
    expect(candidate.result.diagnostics.territory_fallback).toBe(true);
    expect(candidate.result.diagnostics.warnings.join(' ')).toContain('CANADA');
  });

  it('does not raise a fallback warning when the account is worldwide anyway', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: {}, rates: rates(),
    });
    expect(candidate.result.diagnostics.warnings).toEqual([]);
  });

  it('refuses to apply a turnover rate to a payroll exposure', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_unit: 'PAYROLL' }),
      structure: {},
      // Only a TURNOVER rate is loaded.
      rates: rates({ liabilityBaseRates: [TURNOVER_RATE_WW] }),
    });
    expect(candidate.result.available).toBe(false);
    expect(candidate.result.unavailableReason).toContain('PAYROLL');
    expect(candidate.result.unavailableReason).toContain('TURNOVER');
    expect(candidate.result.diagnostics).toEqual({
      section_unit: 'PAYROLL', rate_units: ['TURNOVER'],
    });
    expect(candidate.result.lossCost).toBeUndefined();
  });

  it('reports unavailable, with a reason, when no rate is loaded', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section(),
      structure: {},
      rates: { liabilityBaseRates: [], ilfCurves: [POWER_CURVE_WW] },
    });
    expect(candidate.result.available).toBe(false);
    expect(candidate.result.unavailableReason).toMatch(/base rate/i);
  });

  it('reports unavailable, with a reason, when no curve is loaded', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section(),
      structure: {},
      rates: { liabilityBaseRates: [TURNOVER_RATE_WW], ilfCurves: [] },
    });
    expect(candidate.result.available).toBe(false);
    expect(candidate.result.unavailableReason).toMatch(/ILF curve/i);
  });

  it('reports unavailable when the section carries no exposure base', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_base: null }),
      structure: {},
      rates: rates(),
    });
    expect(candidate.result.available).toBe(false);
    expect(candidate.result.unavailableReason).toMatch(/exposure base/i);
  });

  it('reports unavailable when there is no limit to price to', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ limit_amount: null }),
      structure: {},
      rates: rates(),
    });
    expect(candidate.result.available).toBe(false);
    expect(candidate.result.unavailableReason).toMatch(/limit/i);
  });

  it('steps a first-year claims-made policy down when the curve carries steps', () => {
    const stepped = {
      ...POWER_CURVE_WW,
      params: { ...POWER_CURVE_WW.params, claims_made_steps: [0.4, 0.7, 0.85, 1.0] },
    };
    const occurrence = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: {},
      rates: rates({ ilfCurves: [stepped] }),
    })[0].result;
    const claimsMade = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_detail: { claims_made: true, retro_years: 0 } }),
      structure: {},
      rates: rates({ ilfCurves: [stepped] }),
    })[0].result;
    expect(claimsMade.lossCost).toBeCloseTo(occurrence.lossCost * 0.4, 6);
    expect(claimsMade.diagnostics.claims_made_basis).toBe('CLAIMS_MADE_YEAR_1');
  });

  it('does not invent a claims-made discount when the curve carries no steps', () => {
    const claimsMade = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_detail: { claims_made: true, retro_years: 0 } }),
      structure: {},
      rates: rates(),
    })[0].result;
    expect(claimsMade.diagnostics.claims_made_factor).toBe(1);
    expect(claimsMade.diagnostics.claims_made_basis).toBe('CLAIMS_MADE_NO_STEPS');
  });

  it('loads for defence costs in addition only when the curve says by how much', () => {
    const withFactor = {
      ...POWER_CURVE_WW, params: { ...POWER_CURVE_WW.params, defence_costs_factor: 1.15 },
    };
    const detail = { defence_costs_in_addition: true };
    const priced = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section({ exposure_detail: detail }), structure: {},
      rates: rates({ ilfCurves: [withFactor] }),
    })[0].result;
    const plain = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section({ exposure_detail: detail }), structure: {},
      rates: rates(),
    })[0].result;
    expect(priced.diagnostics.defence_costs_factor).toBe(1.15);
    expect(plain.diagnostics.defence_costs_factor).toBe(1);
  });

  it('says out loud that an entered aggregate limit is not priced (F54)', () => {
    const withAgg = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_detail: { aggregate_limit: 10_000_000 } }),
      structure: {},
      rates: rates(),
    })[0].result;
    const without = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: {}, rates: rates(),
    })[0].result;
    // The price genuinely does not move — and the warning says so instead of
    // letting the entry silently do nothing.
    expect(withAgg.lossCost).toBeCloseTo(without.lossCost, 9);
    expect(withAgg.diagnostics.warnings.join(' ')).toMatch(/aggregate limit is recorded for information/i);
    expect(without.diagnostics.warnings.join(' ')).not.toMatch(/aggregate limit/i);
  });

  it('puts both aggregate fields on the exposure form honestly (F54)', () => {
    const agg = liabilityLimit.exposureFields.find((f) => f.key === 'aggregate_limit');
    const reinst = liabilityLimit.exposureFields.find((f) => f.key === 'aggregate_reinstatements');
    // The recorded-only field is marked informational; the field that
    // multiplies the price is enterable rather than JSON-only.
    expect(agg.informational).toBe(true);
    expect(reinst).toBeTruthy();
    expect(reinst.type).toBe('integer');
    // Marine liability shares the form.
    expect(marineLiability.exposureFields.some((f) => f.key === 'aggregate_reinstatements')).toBe(true);
  });

  it('refuses a curve whose basic limit disagrees with the rate\'s (F52)', () => {
    // A WW curve normalised at 5m paired with a 1m-basic US rate under-
    // priced a 5m primary by 34.5% with clean diagnostics. Now it refuses
    // with both numbers named.
    const fiveMil = { ...POWER_CURVE_WW, curve_code: 'GL-WW-5M', basic_limit: 5_000_000 };
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section(),
      structure: {},
      rates: rates({ ilfCurves: [fiveMil] }),
    });
    expect(candidate.result.available).toBe(false);
    expect(candidate.result.unavailableReason).toMatch(/1,000,000/);
    expect(candidate.result.unavailableReason).toMatch(/5,000,000/);
  });

  it('charges each reinstated aggregate as another limit of exposure', () => {
    const one = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: {}, rates: rates(),
    })[0].result;
    const two = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ exposure_detail: { aggregate_reinstatements: 1 } }),
      structure: {},
      rates: rates(),
    })[0].result;
    expect(two.lossCost).toBeCloseTo(one.lossCost * 2, 6);
    expect(two.diagnostics.aggregate_factor).toBe(2);
  });

  it('expresses the answer as a rate per mille of the exposure base', () => {
    const r = computeCandidates({
      risk: { fac_cob_id: 41 }, section: section(), structure: {}, rates: rates(),
    })[0].result;
    expect(r.ratePm).toBeCloseTo((r.lossCost / 250_000_000) * 1000, 9);
  });

  it('takes the class from the risk when the section does not carry one', () => {
    const [candidate] = computeCandidates({
      risk: { fac_cob_id: 41 },
      section: section({ fac_cob_id: null }),
      structure: {},
      rates: rates(),
    });
    expect(candidate.result.available).toBe(true);
  });
});

describe('the family descriptor', () => {
  it('declares itself implemented with the methods the pipeline expects', () => {
    expect(liabilityLimit.code).toBe('LIABILITY_LIMIT');
    expect(liabilityLimit.implemented).toBe(true);
    expect(liabilityLimit.methods).toContain('ILF_CURVE');
    expect(liabilityLimit.ratingBasis).toBe('LIMIT_ILF');
    expect(typeof liabilityLimit.computeCandidates).toBe('function');
  });

  it('caps credibility below the property family, because layer experience is thinner', () => {
    expect(liabilityLimit.credibility.maxZ).toBeLessThan(0.75);
    expect(liabilityLimit.credibility.k).toBeGreaterThan(8);
  });

  it('asks for no property fields — there is no occupancy or NatCat zone here', () => {
    expect(liabilityLimit.requires).toEqual([]);
    expect(liabilityLimit.wizardSteps).toEqual([]);
  });
});
