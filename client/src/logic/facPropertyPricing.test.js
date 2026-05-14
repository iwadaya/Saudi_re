import { describe, it, expect } from 'vitest';
import {
  computeRatePath,
  computeScoreAndDecision,
  computeFacQuote,
} from './facPropertyPricing.js';

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

describe('computeScoreAndDecision', () => {
  it('lands in the F band (65-70) for the hospital case with a lowered UW perception', () => {
    // Excel Summary Sheet selections produce a score of ~71 (boundary between
    // E and F bands). Downgrading UW Perception from "Good" to "Low" subtracts
    // 0.075 × 80 = 6 from the weighted score, settling cleanly inside F.
    const inputs = hospitalInputs({
      factor_selections: { UW_PERCEPTION: 'Low' },
      // Restore the Excel's BI_PLAN selection so this test exercises the same
      // selections the Summary Sheet shows.
    });
    inputs.factor_selections.BI_PLAN = 'No Business Continuity Plan';

    const rate = computeRatePath(inputs, HOSPITAL_REFERENCE_DATA);
    const result = computeScoreAndDecision(inputs, HOSPITAL_REFERENCE_DATA, rate);

    expect(result.underwriting_score).toBeGreaterThanOrEqual(65);
    expect(result.underwriting_score).toBeLessThan(70);
    expect(result.capacity_grade).toBe('F');
    expect(result.factor_weights_scheme).toBe('WITH_BI');
    expect(result.max_capacity_pct).toBeCloseTo(0.60, 6);
    expect(result.max_capacity_sar).toBe(Math.min(300_000_000, 50_000_000 * 0.60));
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
