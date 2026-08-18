// shared/fac/goldenMaster.fixtures.js
//
// The frozen inputs behind the per-family golden masters.
//
// One fixture per implemented family: a risk, its sections, the reference data
// it rates against, and the underwriting inputs. They live here rather than in
// the test so that the same inputs can drive both the assertion and the
// regeneration script — a golden master whose inputs are written twice is a
// golden master that can drift from itself.
//
// The rates are FIXTURES, not shipped reference data. Every rate table in the
// module ships empty (design doc §8); these numbers exist to pin behaviour, and
// nothing reads them at runtime. They are deliberately round so an expected
// output can be checked by hand.

export const REFERENCE_DATA = {
  occupancies: [{
    occupancy_code: 1, occupancy_name: 'Golden master occupancy',
    hazard_grade: 2, frequency_category: 1, flexa_base_rate_pm: 1.0,
  }],
  factors: [],
  factorWeights: { WITHOUT_BI: {} },
  hazardGradeScore: [{ hazard_grade: 2, score: 97 }],
  frequencyScore: [{ frequency_category: 1, score: 100 }],
  capacityBands: [],
  territorialCapacity: [],
  biIndemnity: {},
  natcatRates: [{ country_zone: 'GM-1', flood_storm_rate: 0.05, earthquake_rate: 0.02 }],
};

const INPUTS = {
  occupancy_code: 1,
  country_zone: 'GM-1',
  commission_pct: 0.20,
  margin_pct: 0.05,
  other_expenses_pct: 0,
  indemnity_months: 12,
};

/** A power ILF curve for a family, at a stated basic limit. */
const ilfCurve = (code, familyCode, basicLimit, doubling) => ({
  curve_code: code, curve_name: `${code} golden master`, kind: 'POWER',
  family_code: familyCode, territory: 'WORLDWIDE',
  basic_limit: basicLimit, params: { doubling_loading: doubling },
  source: 'GOLDEN_MASTER_FIXTURE',
});

/**
 * @typedef {Object} GoldenFixture
 * @property {string} family
 * @property {string} why      what this fixture is pinning, in one line
 * @property {object} args     the priceFacRiskFull arguments
 */

/** @type {GoldenFixture[]} */
export const FIXTURES = [
  {
    family: 'SCHEDULE_PROPERTY',
    why: 'The workbook build-up, and the invariant that it survives the pipeline untouched.',
    args: {
      risk: {
        insured_name: 'Golden Property', uw_year: 2026,
        occupancy_code: 1, risk_country_zone: 'GM-1',
        pd_sum_insured: 100_000_000, bi_sum_insured: 0,
      },
      cob: { rating_family: 'SCHEDULE_PROPERTY' },
      sections: [],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {},
    },
  },
  {
    family: 'LIABILITY_LIMIT',
    why: 'The basic-limit loss cost and the Riebesell step from it to the policy limit.',
    args: {
      risk: { insured_name: 'Golden Manufacturing', uw_year: 2026 },
      cob: { rating_family: 'LIABILITY_LIMIT', fac_cob_id: 'COB-GL' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-GL', fac_cob_id: 'COB-GL',
        rating_family: 'LIABILITY_LIMIT',
        exposure_base: 250_000_000, exposure_unit: 'TURNOVER',
        limit_amount: 5_000_000, attachment: 0, exposure_detail: {},
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        liabilityBaseRates: [{
          fac_cob_id: 'COB-GL', territory: 'WORLDWIDE', basis_unit: 'TURNOVER',
          basis_divisor: 1_000_000, basic_limit: 1_000_000, loss_cost_per_unit: 400,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
        ilfCurves: [ilfCurve('GM-GL', 'LIABILITY_LIMIT', 1_000_000, 0.20)],
      },
    },
  },
  {
    family: 'HULL_VALUE',
    why: 'The tonnage band, the multiplicative factor chain, and war as its own section.',
    args: {
      risk: { insured_name: 'MV Golden', uw_year: 2026, period_from: '2026-01-01' },
      cob: { rating_family: 'HULL_VALUE' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-HULL', rating_family: 'HULL_VALUE',
        sum_insured: 30_000_000,
        exposure_detail: {
          vessel_type: 'BULK_CARRIER', tonnage: 45_000, class_society: 'IACS',
          trading_area: 'WORLDWIDE', war_region: 'GOLDEN_GULF',
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        hullRates: [{
          vessel_type: 'BULK_CARRIER', tonnage_min: 20_000, tonnage_max: 80_000,
          rate_pm: 3.5, source: 'GOLDEN_MASTER_FIXTURE',
        }],
        hullFactors: [
          { factor_kind: 'CLASS', factor_key: 'IACS', factor: 1.0, source: 'GOLDEN_MASTER_FIXTURE' },
          { factor_kind: 'TRADING_AREA', factor_key: 'WORLDWIDE', factor: 1.0, source: 'GOLDEN_MASTER_FIXTURE' },
        ],
        warRates: [{
          region: 'GOLDEN_GULF', basis: 'ANNUAL', rate_pm: 0.75, breach_ap_pm: 0.9,
          effective_from: '2026-01-01', source: 'GOLDEN_MASTER_FIXTURE',
        }],
      },
    },
  },
  {
    family: 'TRANSIT_VALUES',
    why: 'The turnover-weighted blend across segments, and that cargo rates on sendings.',
    args: {
      risk: { insured_name: 'Golden Shipper', uw_year: 2026 },
      cob: { rating_family: 'TRANSIT_VALUES' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-CARGO', rating_family: 'TRANSIT_VALUES',
        exposure_base: 100_000_000, limit_amount: 5_000_000,
        exposure_detail: {
          segments: [
            { commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE', turnover: 60_000_000 },
            { commodity: 'ELECTRONICS', conveyance: 'AIR', route_region: 'WORLDWIDE', turnover: 40_000_000 },
          ],
          max_any_one_conveyance: 5_000_000,
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        transitRates: [
          {
            commodity: 'MACHINERY', conveyance: 'SEA', route_region: 'WORLDWIDE',
            rate_pm: 0.6, source: 'GOLDEN_MASTER_FIXTURE',
          },
          {
            commodity: 'ELECTRONICS', conveyance: 'AIR', route_region: 'WORLDWIDE',
            rate_pm: 0.25, packing_factor: 1.1, source: 'GOLDEN_MASTER_FIXTURE',
          },
        ],
        warRates: [],
      },
    },
  },
  {
    family: 'PROJECT_WORKS',
    why: 'The period factor over a 24-month project, and the separately-rated covers.',
    args: {
      risk: {
        insured_name: 'Golden Power Project', uw_year: 2026,
        inception_date: '2026-01-01', expiry_date: '2028-01-01',
      },
      cob: { rating_family: 'PROJECT_WORKS' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-CAR', rating_family: 'PROJECT_WORKS',
        sum_insured: 200_000_000,
        exposure_detail: {
          project_type: 'POWER', plant_value: 120_000_000, testing_weeks: 8,
          dsu_sum_insured: 60_000_000, dsu_indemnity_months: 12,
          factors: { CONTRACTOR: 'TIER_1' },
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        projectBaseRates: [{
          project_type: 'POWER', territory: 'WORLDWIDE',
          contract_value_min: 50_000_000, contract_value_max: 500_000_000,
          rate_pm: 2.5, period_factor_per_month: 0.03, period_baseline_months: 12,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
        projectFactors: [{
          factor_kind: 'CONTRACTOR', factor_key: 'TIER_1', loading: -0.10,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
        projectLoadRates: [
          {
            load_kind: 'TESTING', load_key: 'DEFAULT', rate_pm: 0.4, per_unit: 'WEEK',
            source: 'GOLDEN_MASTER_FIXTURE',
          },
          {
            load_kind: 'DSU', load_key: 'DEFAULT', rate_pm: 3.0, per_unit: 'FLAT',
            source: 'GOLDEN_MASTER_FIXTURE',
          },
        ],
      },
    },
  },
  {
    family: 'PLANT_OPERATIONAL',
    why: 'Item-level rating with an item-level PML, which is why this family exists.',
    args: {
      risk: { insured_name: 'Golden Plant', uw_year: 2026 },
      cob: { rating_family: 'PLANT_OPERATIONAL' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-MB', rating_family: 'PLANT_OPERATIONAL',
        sum_insured: 50_000_000,
        exposure_detail: {
          items: [
            {
              machine_type: 'GAS_TURBINE', replacement_value: 40_000_000,
              pml_pct: 0.5, age_band: '0-5',
            },
            { machine_type: 'TRANSFORMER', replacement_value: 10_000_000 },
          ],
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        plantBaseRates: [
          {
            machine_type: 'GAS_TURBINE', territory: 'WORLDWIDE', rate_pm: 4.0,
            source: 'GOLDEN_MASTER_FIXTURE',
          },
          {
            machine_type: 'TRANSFORMER', territory: 'WORLDWIDE', rate_pm: 2.2,
            source: 'GOLDEN_MASTER_FIXTURE',
          },
        ],
        plantFactors: [{
          factor_kind: 'AGE', factor_key: '0-5', factor: 0.9,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
      },
    },
  },
  {
    family: 'ENERGY_ASSET',
    why: 'The hazard-band key, the windstorm load, and sub-limits sitting beside the rate.',
    args: {
      risk: { insured_name: 'Golden Platform', uw_year: 2026 },
      cob: { rating_family: 'ENERGY_ASSET' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-ENERGY', rating_family: 'ENERGY_ASSET',
        sum_insured: 800_000_000,
        exposure_detail: {
          asset_type: 'OFFSHORE_PLATFORM', process_hazard_band: 'STANDARD',
          territory: 'GOM', named_windstorm_exposed: true,
          sublimits: { CONTROL_OF_WELL: 150_000_000 },
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        energyBaseRates: [{
          asset_type: 'OFFSHORE_PLATFORM', process_hazard_band: 'STANDARD',
          territory: 'GOM', rate_pm: 5.0, windstorm_season_load_pm: 2.5,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
        energySublimitRates: [{
          sublimit_kind: 'CONTROL_OF_WELL', sublimit_key: 'DEFAULT', rate_pm: 6.0,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
      },
    },
  },
  {
    family: 'CYBER_LIMIT',
    why: 'The controls factor, the cyber-specific curve, and that the tag gate is passed.',
    args: {
      risk: { insured_name: 'Golden SaaS', uw_year: 2026 },
      cob: { rating_family: 'CYBER_LIMIT' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-CYBER', rating_family: 'CYBER_LIMIT',
        exposure_base: 400_000_000, limit_amount: 10_000_000, attachment: 0,
        exposure_detail: {
          dependencies: ['AWS'],
          controls: { MFA: 'ENFORCED_ALL', BACKUPS: 'IMMUTABLE_TESTED' },
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        cyberBaseRates: [{
          industry_code: 'ALL', revenue_min: 100_000_000, revenue_max: 1_000_000_000,
          territory: 'WORLDWIDE', basic_limit: 5_000_000, rate_per_million: 12_000,
          source: 'GOLDEN_MASTER_FIXTURE',
        }],
        cyberControlFactors: [
          {
            control_key: 'MFA', posture: 'ENFORCED_ALL', factor: 0.80,
            source: 'GOLDEN_MASTER_FIXTURE',
          },
          {
            control_key: 'BACKUPS', posture: 'IMMUTABLE_TESTED', factor: 0.75,
            source: 'GOLDEN_MASTER_FIXTURE',
          },
        ],
        ilfCurves: [ilfCurve('GM-CY', 'CYBER_LIMIT', 5_000_000, 0.45)],
      },
    },
  },
  {
    family: 'MOTOR_FLEET',
    why: 'Per vehicle-year costing and the TPL step through the motor curve.',
    args: {
      risk: { insured_name: 'Golden Haulage', uw_year: 2026 },
      cob: { rating_family: 'MOTOR_FLEET' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-MOTOR', rating_family: 'MOTOR_FLEET',
        exposure_base: 500, sum_insured: 60_000_000, limit_amount: 4_000_000,
        exposure_detail: {
          fleet: [
            { vehicle_category: 'PRIVATE', vehicle_count: 400, sum_insured: 30_000_000 },
            { vehicle_category: 'HEAVY', vehicle_count: 100, sum_insured: 30_000_000 },
          ],
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        motorBaseRates: [
          {
            vehicle_category: 'PRIVATE', territory: 'WORLDWIDE',
            od_cost_per_vehicle_year: 900, tpl_cost_per_vehicle_year: 400,
            tpl_basic_limit: 1_000_000, source: 'GOLDEN_MASTER_FIXTURE',
          },
          {
            vehicle_category: 'HEAVY', territory: 'WORLDWIDE',
            od_cost_per_vehicle_year: 3_400, tpl_cost_per_vehicle_year: 2_100,
            tpl_basic_limit: 1_000_000, source: 'GOLDEN_MASTER_FIXTURE',
          },
        ],
        ilfCurves: [ilfCurve('GM-MOT', 'MOTOR_FLEET', 1_000_000, 0.15)],
      },
    },
  },
  {
    family: 'PA_BENEFIT',
    why: 'Benefit units by occupational class, and that 24-hour cover is its own rate.',
    args: {
      risk: { insured_name: 'Golden Scheme', uw_year: 2026 },
      cob: { rating_family: 'PA_BENEFIT' },
      sections: [{
        section_no: 1, section_id: 'GM-SEC-PA', rating_family: 'PA_BENEFIT',
        exposure_base: 400,
        exposure_detail: {
          cover_basis: '24_HOUR', max_one_event_headcount: 45,
          classes: [
            { occupational_class: '1', headcount: 300, benefit_units: 250_000 },
            { occupational_class: '4', headcount: 100, benefit_units: 150_000 },
          ],
        },
      }],
      inputs: INPUTS,
      referenceData: REFERENCE_DATA,
      rates: {
        paBaseRates: [
          {
            occupational_class: '1', cover_basis: '24_HOUR', territory: 'WORLDWIDE',
            rate_per_unit: 0.0012, source: 'GOLDEN_MASTER_FIXTURE',
          },
          {
            occupational_class: '4', cover_basis: '24_HOUR', territory: 'WORLDWIDE',
            rate_per_unit: 0.0065, source: 'GOLDEN_MASTER_FIXTURE',
          },
        ],
      },
    },
  },
];

/**
 * The subset of a priced result that a golden master pins.
 *
 * Deliberately not the whole object: diagnostics carry prose that will be
 * reworded, and pinning prose would make every copy edit look like a rate
 * change. What is pinned is what an underwriter would notice moving — the
 * candidates, the blend, the loads, and the money.
 *
 * @param {object} priced  priceFacRiskFull output
 * @returns {object}
 */
export function pinnedShape(priced) {
  const round = (v, dp = 8) => (
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? null
      : Number(Number(v).toFixed(dp))
  );

  const technical = priced.technical || {};
  return {
    ok: priced.ok,
    family: priced.family,
    exposure_basis: priced.exposure?.basis ?? null,
    engine_final_gross_rate_pm: round(priced.result?.final_gross_rate_pm),
    candidates: (technical.candidates || []).map((c) => ({
      code: c.code,
      role: c.role,
      available: c.available,
      rate_pm: round(c.ratePm),
      loss_cost: round(c.lossCost, 4),
      weight: round(technical.weights?.[c.code], 6),
    })),
    blended_loss_cost_pm: round(technical.blendedLossCostPm),
    additive_load_pm: round(technical.additiveLoadPm),
    expected_loss_pm: round(technical.expectedLossPm),
    risk_load_pm: round(technical.riskLoadPm),
    technical_net_pm: round(technical.technicalNetPm),
    gross_up_denominator: round(technical.grossUpDenominator, 6),
    technical_gross_pm: round(technical.technicalGrossPm),
    premiums: {
      expected_loss: round(technical.premiums?.expectedLoss, 4),
      technical_net: round(technical.premiums?.technicalNet, 4),
      technical_gross: round(technical.premiums?.technicalGross, 4),
    },
    sections: (priced.sections || []).map((s) => ({
      family: s.family,
      premium_base: round(s.premium_base, 4),
      loss_cost: round(s.loss_cost, 4),
      rate_pm: round(s.rate_pm),
    })),
  };
}
