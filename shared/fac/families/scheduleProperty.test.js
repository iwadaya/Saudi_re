import { describe, it, expect } from 'vitest';
import {
  computeRatePath,
  computeScoreAndDecision,
  computePremiums,
  computeFacQuote,
  computeCandidates,
  SCORE_COMPLETENESS_MIN,
} from './scheduleProperty.js';
import { buildExposureProfile } from '../exposure.js';

// ────────────────────────────────────────────────────────────────────────────
// Hospital example (occupancy 102) — Pricing_TOOL.xlsx Premium Calculator
// + Summary Sheet, scoped to just the rows the engine touches in this test.
// ────────────────────────────────────────────────────────────────────────────

const HOSPITAL_REFERENCE_DATA = {
  occupancies: [
    {
      occupancy_code: 102,
      occupancy_name: 'Hospitals including X-ray and other Diagnostic clinics',
      hazard_grade: 2,
      frequency_category: 1,
      flexa_base_rate_pm: 0.25,
    },
  ],
  factors: [
    { factor_code: 'HAZARD_GRADE',    affects_score: true, options: [] },
    { factor_code: 'FREQUENCY_GRADE', affects_score: true, options: [] },
    {
      factor_code: 'CONSTRUCTION',
      affects_score: true,
      options: [
        { option_label: 'Class A - RCC roof and Structure', score: 100, discount_loading: -0.10 },
      ],
    },
    {
      factor_code: 'AGE_OF_RISK',
      affects_score: true,
      options: [
        { option_label: 'Less than 10 Years', score: 100, discount_loading: -0.10 },
      ],
    },
    {
      factor_code: 'CLAIM_EXPERIENCE',
      affects_score: true,
      options: [
        { option_label: 'Average', score: 50, discount_loading: 0 },
      ],
    },
    {
      factor_code: 'FIRE_FIGHTING',
      affects_score: true,
      options: [
        { option_label: 'Type 2 - Partially Sprinkler and Hydrant System', score: 80, discount_loading: -0.10 },
      ],
    },
    {
      factor_code: 'EXTERNAL_EXPOSURE',
      affects_score: true,
      options: [
        { option_label: 'Average', score: 60, discount_loading: 0 },
      ],
    },
    {
      factor_code: 'NATCAT_EXPOSURE',
      affects_score: true,
      options: [
        { option_label: 'Moderate', score: 80, discount_loading: null },
      ],
    },
    {
      factor_code: 'MANAGEMENT',
      affects_score: true,
      options: [
        { option_label: 'Average or not known', score: 50, discount_loading: 0 },
      ],
    },
    {
      factor_code: 'SURVEY_RATING',
      affects_score: true,
      options: [
        { option_label: 'Average', score: 50, discount_loading: 0 },
      ],
    },
    {
      factor_code: 'SURVEY_AGE',
      affects_score: true,
      options: [
        { option_label: '3 Years or Less', score: 100, discount_loading: null },
      ],
    },
    {
      factor_code: 'DEDUCTIBLE_LEVEL',
      affects_score: true,
      options: [
        { option_label: 'Above Average', score: 80, discount_loading: -0.10 },
      ],
    },
    {
      factor_code: 'GROSS_RETENTION',
      affects_score: true,
      options: [
        { option_label: 'Excellent', score: 100, discount_loading: null },
      ],
    },
    {
      factor_code: 'NUMBER_OF_LOCATIONS',
      affects_score: true,
      options: [
        { option_label: 'Less than 5', score: 100, discount_loading: null },
      ],
    },
    {
      factor_code: 'TOP_OCCUPANCY_PCT',
      affects_score: true,
      options: [
        { option_label: 'More than 70% for same occupancies', score: 100, discount_loading: 0 },
      ],
    },
    {
      factor_code: 'TOP_LOCATION_PCT',
      affects_score: true,
      options: [
        { option_label: 'More than 70%', score: 100, discount_loading: null },
      ],
    },
    {
      factor_code: 'UW_PERCEPTION',
      affects_score: true,
      options: [
        { option_label: 'Good',     score:  80, discount_loading: null },
        { option_label: 'Low',      score:   0, discount_loading: null },
        { option_label: 'Very Low', score: -50, discount_loading: null },
      ],
    },
    {
      factor_code: 'MARKET_VS_TECH',
      affects_score: true,
      options: [
        { option_label: 'More than Equal to 80%', score: 100, discount_loading: null },
        { option_label: 'Less than 40%',          score: -30, discount_loading: null },
      ],
    },
    {
      factor_code: 'CLIENT_RELATIONSHIP',
      affects_score: true,
      options: [
        { option_label: 'Excellent', score: 100, discount_loading: null },
      ],
    },
    {
      factor_code: 'BI_PLAN',
      affects_score: true,
      options: [
        { option_label: 'Has Some Business Continuity Plan', score:  70, discount_loading:  0.00 },
        { option_label: 'No Business Continuity Plan',       score: -15, discount_loading:  0.30 },
      ],
    },
  ],
  factorWeights: {
    WITH_BI: {
      HAZARD_GRADE: 0.215, FREQUENCY_GRADE: 0.10,
      CONSTRUCTION: 0.07,  AGE_OF_RISK: 0.025, CLAIM_EXPERIENCE: 0.03,
      FIRE_FIGHTING: 0.09, EXTERNAL_EXPOSURE: 0.015, NATCAT_EXPOSURE: 0.04,
      MANAGEMENT: 0.03,    SURVEY_RATING: 0.085, SURVEY_AGE: 0.01,
      DEDUCTIBLE_LEVEL: 0.025, GROSS_RETENTION: 0.01, TOP_OCCUPANCY_PCT: 0.015,
      UW_PERCEPTION: 0.075, MARKET_VS_TECH: 0.06, CLIENT_RELATIONSHIP: 0.02,
      NUMBER_OF_LOCATIONS: 0.005, TOP_LOCATION_PCT: 0.01, BI_PLAN: 0.07,
    },
    WITHOUT_BI: {
      HAZARD_GRADE: 0.225, FREQUENCY_GRADE: 0.10,
      CONSTRUCTION: 0.08,  AGE_OF_RISK: 0.025, CLAIM_EXPERIENCE: 0.03,
      FIRE_FIGHTING: 0.10, EXTERNAL_EXPOSURE: 0.03, NATCAT_EXPOSURE: 0.05,
      MANAGEMENT: 0.03,    SURVEY_RATING: 0.10, SURVEY_AGE: 0.01,
      DEDUCTIBLE_LEVEL: 0.025, GROSS_RETENTION: 0.01, TOP_OCCUPANCY_PCT: 0.015,
      UW_PERCEPTION: 0.075, MARKET_VS_TECH: 0.06, CLIENT_RELATIONSHIP: 0.02,
      NUMBER_OF_LOCATIONS: 0.005, TOP_LOCATION_PCT: 0.01, BI_PLAN: 0,
    },
  },
  hazardGradeScore: [
    { hazard_grade: 1, score: 100 }, { hazard_grade: 2, score: 97 },
    { hazard_grade: 3, score: 95 }, { hazard_grade: 4, score: 85 },
    { hazard_grade: 5, score: 82 }, { hazard_grade: 6, score: 80 },
    { hazard_grade: 7, score: 60 }, { hazard_grade: 8, score: 50 },
    { hazard_grade: 9, score: 25 }, { hazard_grade: 10, score: 20 },
  ],
  frequencyScore: [
    { frequency_category: 1, score: 100 }, { frequency_category: 2, score: 80 },
    { frequency_category: 3, score: 40 }, { frequency_category: 4, score: 20 },
  ],
  capacityBands: [
    { grade: 'A', score_min: 95, score_max: 100, description: 'Excellent Quality',  max_capacity_pct: 1.00, min_tech_rate_pm: 0.300, underwriting_action: 'Accept' },
    { grade: 'B', score_min: 90, score_max:  95, description: 'Very Good Quality',  max_capacity_pct: 0.90, min_tech_rate_pm: 0.250, underwriting_action: 'Accept' },
    { grade: 'C', score_min: 80, score_max:  90, description: 'Good Quality',       max_capacity_pct: 0.80, min_tech_rate_pm: 0.225, underwriting_action: 'Accept' },
    { grade: 'D', score_min: 75, score_max:  80, description: 'Moderately Good',    max_capacity_pct: 0.75, min_tech_rate_pm: 0.175, underwriting_action: 'Accept' },
    { grade: 'E', score_min: 70, score_max:  75, description: 'Above Average',      max_capacity_pct: 0.70, min_tech_rate_pm: 0.150, underwriting_action: 'Accept' },
    { grade: 'F', score_min: 65, score_max:  70, description: 'Average',            max_capacity_pct: 0.60, min_tech_rate_pm: 0.125, underwriting_action: 'Accept with Caution' },
    { grade: 'G', score_min: 60, score_max:  65, description: 'Below Average',      max_capacity_pct: 0.50, min_tech_rate_pm: 0.100, underwriting_action: 'Accept in Exceptional Situation' },
    { grade: 'H', score_min: 55, score_max:  60, description: 'Bad Risk',           max_capacity_pct: 0.20, min_tech_rate_pm: 0.050, underwriting_action: 'Accept in Exceptional Situation' },
    { grade: 'I', score_min: 50, score_max:  55, description: 'Very Bad Risk',      max_capacity_pct: 0.20, min_tech_rate_pm: 0.050, underwriting_action: 'DECLINE or Referral to Non Life Head' },
    { grade: 'J', score_min: 40, score_max:  50, description: 'Unacceptable Risk',  max_capacity_pct: 0.10, min_tech_rate_pm: 0.050, underwriting_action: 'DECLINE or Referral to Non Life Head' },
    { grade: 'K', score_min:  0, score_max:  40, description: 'Below 40 - DECLINE', max_capacity_pct: 0.00, min_tech_rate_pm: 0.000, underwriting_action: 'DECLINE' },
  ],
  territorialCapacity: [
    { region: 'KSA', max_capacity: 300_000_000 },
  ],
  biIndemnity: { '12': 1.25 },
  natcatRates: [
    { country_zone: 'KSA - Whole Country', flood_storm_rate: 0.03, earthquake_rate: 0.015 },
  ],
};

// Selections from the Summary Sheet. BI_PLAN defaults to "Has Some" so the
// (1 + bi_plan_dl) multiplier in the BI rate formula is 1 — matches the
// stated `bi_rate = 0.1815 × 1.25 = 0.226875` target in test 1.
function hospitalInputs(overrides = {}) {
  const { factor_selections: selOverrides, ...restOverrides } = overrides;
  return {
    occupancy_code: 102,
    country_zone: 'KSA - Whole Country',
    region: 'KSA',
    pd_si_share_pct: 1.0,
    indemnity_months: 12,
    commission_pct: 0.20,
    margin_pct: 0.05,
    other_expenses_pct: 0.005,
    extra_cover_loadings: [],
    bi_included: true,
    market_rate_pm: 0,
    top_location_si_sar: 50_000_000,
    ...restOverrides,
    factor_selections: {
      CONSTRUCTION: 'Class A - RCC roof and Structure',
      AGE_OF_RISK: 'Less than 10 Years',
      CLAIM_EXPERIENCE: 'Average',
      FIRE_FIGHTING: 'Type 2 - Partially Sprinkler and Hydrant System',
      EXTERNAL_EXPOSURE: 'Average',
      NATCAT_EXPOSURE: 'Moderate',
      MANAGEMENT: 'Average or not known',
      SURVEY_RATING: 'Average',
      SURVEY_AGE: '3 Years or Less',
      DEDUCTIBLE_LEVEL: 'Above Average',
      GROSS_RETENTION: 'Excellent',
      NUMBER_OF_LOCATIONS: 'Less than 5',
      TOP_OCCUPANCY_PCT: 'More than 70% for same occupancies',
      TOP_LOCATION_PCT: 'More than 70%',
      UW_PERCEPTION: 'Good',
      CLIENT_RELATIONSHIP: 'Excellent',
      BI_PLAN: 'Has Some Business Continuity Plan',
      ...selOverrides,
    },
  };
}


// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe('computeRatePath — hospital example (Premium Calculator)', () => {
  it('reproduces the Excel cell values for the hospital case', () => {
    const result = computeRatePath(hospitalInputs(), HOSPITAL_REFERENCE_DATA);
    expect(result.flexa_base_rate_pm).toBeCloseTo(0.2500, 6);
    expect(result.technical_rate_no_natcat_pm).toBeCloseTo(0.1500, 6);
    expect(result.flood_storm_rate_loaded_pm).toBeCloseTo(0.0210, 6);
    expect(result.earthquake_rate_loaded_pm).toBeCloseTo(0.0105, 6);
    expect(result.total_rate_pm).toBeCloseTo(0.1815, 6);
    // BI rate = total × indemnity × (1 + bi_plan_dl). With BI_PLAN = "Has
    // Some BCP" the loading is 0, so it reduces to 0.1815 × 1.25 = 0.226875.
    expect(result.bi_rate_pm).toBeCloseTo(0.226875, 6);
  });
});

// Selections used by the scoring tests: UW Perception downgraded to "Low"
// (score 0 instead of 80) and the Excel's own BI_PLAN choice restored.
function lowPerceptionInputs(overrides = {}) {
  const inputs = hospitalInputs({
    factor_selections: { UW_PERCEPTION: 'Low' },
    ...overrides,
  });
  inputs.factor_selections.BI_PLAN = 'No Business Continuity Plan';
  return inputs;
}

describe('computeScoreAndDecision — every factor scored', () => {
  // Weighted sum of the hospital selections, MARKET_VS_TECH included:
  //   hazard 97×.215 + freq 100×.10 + constr 100×.07 + age 100×.025
  //   + claim 50×.03 + fire 80×.09 + external 60×.015 + natcat 80×.04
  //   + mgmt 50×.03 + survey 50×.085 + surveyAge 100×.01 + deduct 80×.025
  //   + grossRet 100×.01 + topOcc 100×.015 + uwPerc 0×.075
  //   + client 100×.02 + numLoc 100×.005 + topLoc 100×.01 + biPlan −15×.07
  //   = 66.855, before the market-vs-tech term.
  // Market rate 0.16‰ against a 0.1815‰ final net is 88.2% → the top band
  // (score 100) → +6.00 → 72.855 over the full 1.0 weight.
  it('uses the plain weighted average when the whole scheme is selected', () => {
    const inputs = lowPerceptionInputs({ market_rate_pm: 0.16 });

    const rate = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    const result = computeScoreAndDecision(inputs, HOSPITAL_REFERENCE_DATA, rate);

    expect(result.market_vs_tech_band).toBe('More than Equal to 80%');
    expect(result.score_completeness).toBeCloseTo(1.0, 9);
    expect(result.unscored_factors).toEqual([]);
    expect(result.underwriting_score).toBeCloseTo(72.855, 6);
    expect(result.capacity_grade).toBe('E');
    expect(result.factor_weights_scheme).toBe('WITH_BI');
    expect(result.max_capacity_pct).toBeCloseTo(0.70, 6);
  });
});

describe('computeScoreAndDecision — a blank market rate is unscored, not the worst band (F5b)', () => {
  // Before the fix, no market rate meant the band cascade fell through to
  // "Less than 40%" — score −30 against a 6% weight. Simply not having typed
  // a number yet cost 1.8 points and could drop a risk a whole grade.
  it('drops MARKET_VS_TECH out of the average and renormalises', () => {
    const inputs = lowPerceptionInputs();          // market_rate_pm: 0
    const rate = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    const result = computeScoreAndDecision(inputs, HOSPITAL_REFERENCE_DATA, rate);

    expect(result.market_vs_tech_band).toBeNull();
    expect(result.market_vs_tech_pct).toBeNull();
    expect(result.unscored_factors).toEqual(['MARKET_VS_TECH']);
    expect(result.score_completeness).toBeCloseTo(0.94, 9);

    // 66.855 over the 0.94 of weight actually scored — NOT 65.055 over 1.0,
    // which is what the phantom −30 used to produce.
    expect(result.underwriting_score).toBeCloseTo(66.855 / 0.94, 6);
    expect(result.underwriting_score).toBeGreaterThan(65.055);
    expect(result.capacity_grade).toBe('E');
  });
});

describe('computeScoreAndDecision — completeness gate (F5)', () => {
  it('withholds the grade and reports INCOMPLETE below the floor', () => {
    // Two selections out of a 20-factor scheme. The old engine scored the
    // other eighteen as 0 — mid-scale on a −100..+100 range — landing the
    // risk on grade K, which reads as DECLINE. An unfinished form is not a
    // bad risk.
    const inputs = hospitalInputs();
    inputs.factor_selections = {
      CONSTRUCTION: 'Class A - RCC roof and Structure',
      AGE_OF_RISK: 'Less than 10 Years',
    };

    const rate = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    const result = computeScoreAndDecision(inputs, HOSPITAL_REFERENCE_DATA, rate);

    expect(result.score_completeness).toBeLessThan(SCORE_COMPLETENESS_MIN);
    expect(result.uw_action).toBe('INCOMPLETE');
    expect(result.capacity_grade).toBeNull();
    expect(result.capacity_band).toBeNull();
    expect(result.max_capacity_sar).toBeNull();
    expect(result.warnings.some((w) => /provisional/i.test(w))).toBe(true);
    // Hazard and frequency still score — they come from the occupancy, not
    // from a dropdown the underwriter has yet to touch.
    expect(result.factor_scores.HAZARD_GRADE).toBe(97);
    expect(result.unscored_factors).toContain('UW_PERCEPTION');
  });

  it('issues a grade once enough of the weight is selected', () => {
    const result = computeScoreAndDecision(
      lowPerceptionInputs(), HOSPITAL_REFERENCE_DATA,
      computeRatePath(lowPerceptionInputs(), HOSPITAL_REFERENCE_DATA),
    );
    expect(result.score_completeness).toBeGreaterThanOrEqual(SCORE_COMPLETENESS_MIN);
    expect(result.uw_action).toBe('ACCEPT');
    expect(result.capacity_grade).toBe('E');
  });
});

describe('max_capacity_sar — territorial budget is an absolute cap (F7)', () => {
  // The two branches used to disagree: with a top location the territorial
  // figure was compared raw, without one it was multiplied by the grade
  // percentage. Which answer you got depended on whether a region happened
  // to be selected.
  it('takes the lesser of the territorial budget and the graded line', () => {
    const inputs = lowPerceptionInputs();  // grade E → 70%, top location 50m
    const result = computeScoreAndDecision(
      inputs, HOSPITAL_REFERENCE_DATA, computeRatePath(inputs, HOSPITAL_REFERENCE_DATA),
    );
    expect(result.max_capacity_sar).toBe(Math.min(300_000_000, 50_000_000 * 0.70));
  });

  it('uses the graded line alone when no region is set', () => {
    const inputs = lowPerceptionInputs({ region: null });
    const result = computeScoreAndDecision(
      inputs, HOSPITAL_REFERENCE_DATA, computeRatePath(inputs, HOSPITAL_REFERENCE_DATA),
    );
    expect(result.max_capacity_sar).toBe(50_000_000 * 0.70);
  });

  it('uses the territorial budget unscaled when there is no exposure to grade', () => {
    const inputs = lowPerceptionInputs({ top_location_si_sar: null });
    const result = computeScoreAndDecision(
      inputs, HOSPITAL_REFERENCE_DATA, computeRatePath(inputs, HOSPITAL_REFERENCE_DATA),
    );
    expect(result.max_capacity_sar).toBe(300_000_000);
  });
});

describe('fractions are never silently rescaled (F8)', () => {
  it('applies an extra-cover loading at face value and warns when it looks like a percentage', () => {
    // 15 in a fraction field is 1500%, not 15%. The old pct() helper divided
    // anything above 1 by 100, which also turned a legitimate 150% loading
    // (1.5) into 1.5%.
    const inputs = hospitalInputs({
      extra_cover_loadings: [{ label: 'Terrorism', pct: 15 }],
    });
    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);

    expect(result.extra_cover_loading_total).toBe(15);
    expect(result.final_net_rate_pm).toBeCloseTo(result.net_rate_pm * 16, 9);
    expect(result.warnings.some((w) => /Terrorism.*fraction/i.test(w))).toBe(true);
  });

  it('accepts a loading above 100% without rescaling it', () => {
    const inputs = hospitalInputs({
      extra_cover_loadings: [{ label: 'War', pct: 1.5 }],
    });
    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    expect(result.final_net_rate_pm).toBeCloseTo(result.net_rate_pm * 2.5, 9);
  });

  it('sums bare numbers as well as { label, pct } rows', () => {
    const inputs = hospitalInputs({ extra_cover_loadings: [0.1, { pct: 0.05 }] });
    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    expect(result.extra_cover_loading_total).toBeCloseTo(0.15, 9);
  });
});

describe('BI weighting comes from one exposure profile (F10)', () => {
  it('prices the BI rate into the net rate when the profile carries BI', () => {
    const inputs = hospitalInputs({
      pd_si_share_pct: undefined,
      bi_included: undefined,
      exposure: {
        basis: 'LOCATIONS',
        pd_si: 400_000_000,
        bi_si: 100_000_000,
        total_si: 500_000_000,
        pd_si_share: 0.8,
        bi_included: true,
        top_location_si: 360_000_000,
        warnings: [],
      },
    });
    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);

    // 0.8 × total + 0.2 × BI — the BI rate actually moves the answer.
    expect(result.net_rate_pm).toBeCloseTo(0.8 * 0.1815 + 0.2 * 0.226875, 9);
    expect(result.net_rate_pm).toBeGreaterThan(result.total_rate_pm);
  });

  it('leaves the net rate at the total rate when the profile has no BI', () => {
    const inputs = hospitalInputs({
      pd_si_share_pct: undefined,
      bi_included: undefined,
      exposure: {
        basis: 'RISK_HEADER',
        pd_si: 500_000_000, bi_si: 0, total_si: 500_000_000,
        pd_si_share: 1, bi_included: false, top_location_si: 500_000_000, warnings: [],
      },
    });
    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    expect(result.bi_rate_pm).toBe(0);
    expect(result.net_rate_pm).toBeCloseTo(result.total_rate_pm, 9);
  });
});

describe('computePremiums — one sum insured (F11)', () => {
  it('computes both premiums against the profile total, whatever its source', () => {
    const inputs = hospitalInputs();
    const rate = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    const exposure = {
      basis: 'SECTIONS', total_si: 200_000_000,
      pd_si: 200_000_000, bi_si: 0, pd_si_share: 1, bi_included: false,
      top_location_si: 200_000_000, warnings: [],
    };
    const premiums = computePremiums(rate, exposure);

    expect(premiums.sum_insured).toBe(200_000_000);
    expect(premiums.exposure_basis).toBe('SECTIONS');
    expect(premiums.technical).toBeCloseTo(rate.technical_rate_no_natcat_pm * 200_000_000 / 1000, 6);
    expect(premiums.expected).toBeCloseTo(rate.final_gross_rate_pm * 200_000_000 / 1000, 6);
  });

  it('returns nulls rather than zero when there is no exposure to price against', () => {
    const rate = computeRatePath(hospitalInputs(), HOSPITAL_REFERENCE_DATA);
    expect(computePremiums(rate, { basis: 'NONE', total_si: 0 })).toMatchObject({
      technical: null, expected: null,
    });
  });
});

describe('capacity band boundaries', () => {
  it('picks the higher band when two share a boundary score', () => {
    // Bands are inclusive at both ends, so 95 sits in both "90-95" and
    // "95-100". The answer must not depend on the order the reference query
    // returned them in.
    const shuffled = {
      ...HOSPITAL_REFERENCE_DATA,
      capacityBands: [...HOSPITAL_REFERENCE_DATA.capacityBands].reverse(),
    };
    const inputs = hospitalInputs({
      factor_selections: { UW_PERCEPTION: 'Good' },
      market_rate_pm: 0.16,
    });
    const rate = computeRatePath(inputs, shuffled);
    const a = computeScoreAndDecision(inputs, HOSPITAL_REFERENCE_DATA, rate);
    const b = computeScoreAndDecision(inputs, shuffled, rate);
    expect(b.capacity_grade).toBe(a.capacity_grade);
  });
});

describe('error handling', () => {
  it('throws on unknown occupancy_code', () => {
    expect(() =>
      computeRatePath(hospitalInputs({ occupancy_code: 99_999 }), HOSPITAL_REFERENCE_DATA)
    ).toThrow(/unknown occupancy_code/i);
  });

  it('warns and skips when a rate-affecting factor selection is missing', () => {
    const inputs = hospitalInputs();
    delete inputs.factor_selections.CONSTRUCTION;

    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);

    expect(result.warnings.some((w) => /CONSTRUCTION/.test(w))).toBe(true);
    // CONSTRUCTION contributes −0.10 to the rate D/L. Without it, tech rate
    // becomes 0.25 × (1 − 0.30) = 0.175 instead of 0.150.
    expect(result.technical_rate_no_natcat_pm).toBeCloseTo(0.175, 6);
  });
});

describe('final_gross denominator clamp', () => {
  it('returns final_net (not Infinity / NaN) when commission + margin + expenses ≥ 1', () => {
    const inputs = hospitalInputs({
      commission_pct: 0.50,
      margin_pct: 0.30,
      other_expenses_pct: 0.20,
    });
    const result = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);

    expect(result.warnings.some((w) => /denominator/i.test(w))).toBe(true);
    expect(Number.isFinite(result.final_gross_rate_pm)).toBe(true);
    expect(result.final_gross_rate_pm).toBeCloseTo(result.final_net_rate_pm, 12);
  });
});

describe('computeFacQuote (wrapper)', () => {
  it('merges the rate-path and score-path results into one shape', () => {
    const result = computeFacQuote(hospitalInputs(), HOSPITAL_REFERENCE_DATA);

    // Keys from computeRatePath
    for (const key of [
      'flexa_base_rate_pm',
      'technical_rate_no_natcat_pm',
      'flood_storm_rate_loaded_pm',
      'earthquake_rate_loaded_pm',
      'total_rate_pm',
      'bi_rate_pm',
      'net_rate_pm',
      'final_net_rate_pm',
      'final_gross_rate_pm',
    ]) {
      expect(result).toHaveProperty(key);
      expect(Number.isFinite(result[key])).toBe(true);
    }
    // Keys from computeScoreAndDecision
    for (const key of [
      'underwriting_score',
      'factor_weights_scheme',
      'capacity_grade',
      'capacity_band',
      'uw_action',
      'max_capacity_pct',
      'max_capacity_sar',
      'market_vs_tech_band',
    ]) {
      expect(result).toHaveProperty(key);
    }
    // Combined warnings array
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('computeCandidates — the exposure curve uses the recorded PML (F9/F12)', () => {
  // MBBEFD(b=3, g=7): G(x) = ln(10·3^x − 9) / ln(21). The docstring's own
  // convention: MPL = SI × PML, with PML a 0..1 fraction on the profile.
  const CURVE_BANDS = [{
    min_exposure: 0, max_exposure: null,
    curve: { curve_code: 'TEST-MBBEFD', kind: 'MBBEFD', params: { b: 3, g: 7 } },
  }];
  // Ground-up expected loss: 20m SI × 1‰ = 20,000.
  const engine = { final_net_rate_pm: 1.0, technical_rate_no_natcat_pm: 1.0 };
  const priceLayer = (exposure, structure) => computeCandidates({
    engine, exposure, structure, rates: { curveBands: CURVE_BANDS },
  }).find((c) => c.code === 'EXPOSURE_CURVE').result;

  const PML_50 = buildExposureProfile({
    risk: { pd_sum_insured: 20_000_000, bi_sum_insured: 0, pml_pct: 50 },
  });

  it('prices a layer attaching above SI × PML at nil', () => {
    // True MPL = 20m × 0.5 = 10m, so a 10m xs 10m layer sits entirely above
    // the maximum possible loss and must cost nothing.
    const out = priceLayer(PML_50, { attachment: 10_000_000, limit: 10_000_000 });
    expect(out.available).toBe(true);
    expect(out.diagnostics.bands[0].pml_pct).toBeCloseTo(0.5, 12);
    expect(out.lossCost).toBeCloseTo(0, 9);
  });

  it('gives the working layer the whole ground-up cost when it spans the MPL', () => {
    const out = priceLayer(PML_50, { attachment: 0, limit: 10_000_000 });
    // The 10m primary layer contains the entire 10m MPL: G(1) − G(0) = 1.
    expect(out.lossCost).toBeCloseTo(20_000, 6);
  });

  it('falls back to MPL = SI, with a warning, when no PML is recorded', () => {
    const noPml = buildExposureProfile({
      risk: { pd_sum_insured: 20_000_000, bi_sum_insured: 0 },
    });
    const out = priceLayer(noPml, { attachment: 10_000_000, limit: 10_000_000 });
    const G = (x) => Math.log(10 * 3 ** x - 9) / Math.log(21);
    expect(out.diagnostics.bands[0].pml_pct).toBe(1);
    expect(out.lossCost).toBeCloseTo(20_000 * (1 - G(0.5)), 6);   // ≈ 6,080.82
    expect(out.diagnostics.warnings.join(' ')).toMatch(/MPL = full sum insured/);
  });
});
