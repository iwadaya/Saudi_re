// shared/fac/families/motorFleet.js
//
// The MOTOR_FLEET rating family.
//
// Motor is the one family in the module where the risk's own experience is
// usually the best evidence available, and the rate table is the fallback
// rather than the anchor. A 600-vehicle fleet generates hundreds of claims a
// year; the law of large numbers does the work that an exposure curve has to
// do everywhere else. That is why the credibility cap is 0.90 here and 0.50
// on cyber.
//
//   ownDamage = vehicles_c × odCostPerVehicleYear(category, territory)
//   liability = vehicles_c × tplCostPerVehicleYear(category, territory)
//               × [ ILF(limit) ÷ ILF(basicLimit) ]     where a limit is written
//   lossCost  = Σ_categories (ownDamage + liability) × (1 − ncd)
//
// The TPL step uses the same ILF machinery as casualty, on a curve whose
// family is MOTOR_FLEET, because a motor liability limit steps differently
// from a general-liability one — the severity is dominated by bodily injury
// awards with their own tail.
//
// The no-claims / fleet-rating adjustment is an underwriter input rather than
// a table: it is negotiated per fleet against the experience the burning-cost
// and frequency-severity methods are already showing beside it.
//
// fac_motor_base_rate ships empty (migration 137).

import { ilfEvaluator } from '../methods/ilfCurve.js';
import { pickByTerritory } from '../rateSelect.js';
import { selectIlfCurve } from './liabilityLimit.js';
import { num, numOrNull } from '../num.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'MOTOR_FLEET';

export const VEHICLE_CATEGORIES = [
  'PRIVATE', 'COMMERCIAL', 'HEAVY', 'SPECIAL', 'MOTORCYCLE',
];

/**
 * @param {object|null} section
 * @returns {object}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  const raw = Array.isArray(detail.fleet) && detail.fleet.length > 0
    ? detail.fleet
    : [{
      vehicle_category: detail.vehicle_category || null,
      vehicle_count: numOrNull(section?.exposure_base) ?? numOrNull(detail.vehicle_count),
      sum_insured: numOrNull(section?.sum_insured),
    }];

  const fleet = raw.map((v) => ({
    category: (v.vehicle_category || v.category || '').toUpperCase() || null,
    count: numOrNull(v.vehicle_count ?? v.count),
    sumInsured: numOrNull(v.sum_insured ?? v.sumInsured),
  }));

  return {
    fleet,
    totalVehicles: fleet.reduce((t, v) => t + num(v.count), 0),
    totalSumInsured: fleet.reduce((t, v) => t + num(v.sumInsured), 0),
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    tplLimit: numOrNull(section?.limit_amount) ?? numOrNull(detail.tpl_limit),
    // Negotiated, not tabled — see the module header.
    ncdPct: numOrNull(detail.ncd_pct),
    coverBasis: (detail.cover_basis || 'COMPREHENSIVE').toUpperCase(),
  };
}

/**
 * @param {Array<object>} rates fac_motor_base_rate rows
 * @param {{category: string|null, territory: string|null}} args
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function selectMotorRate(rates, { category, territory }) {
  const pool = (rates || []).filter(
    (r) => (r.vehicle_category || '').toUpperCase() === (category || '').toUpperCase(),
  );
  return pickByTerritory(pool, territory);
}

/**
 * The increased-limit step for third-party liability.
 *
 * Returns 1 when no limit is written (unlimited TPL, as several markets
 * require) or when the rate is already quoted at the limit being written —
 * never a guess at a step that has no curve behind it.
 *
 * @param {object} args
 * @param {number|null} args.limit
 * @param {number|null} args.basicLimit
 * @param {object|null} args.curve
 * @returns {{factor: number, basis: string}}
 */
export function tplLimitFactor({ limit, basicLimit, curve }) {
  const l = numOrNull(limit);
  const b = numOrNull(basicLimit);
  if (l === null || b === null || !(b > 0)) return { factor: 1, basis: 'AT_BASIC_LIMIT' };
  if (l === b) return { factor: 1, basis: 'AT_BASIC_LIMIT' };
  if (!curve) return { factor: 1, basis: 'NO_CURVE_LOADED' };
  const ILF = ilfEvaluator(curve);
  const top = ILF(l);
  const bottom = ILF(b);
  if (!(bottom > 0)) return { factor: 1, basis: 'NO_CURVE_LOADED' };
  return { factor: top / bottom, basis: `ILF(${l}) / ILF(${b})` };
}

/**
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {object} args.rates {motorBaseRates, ilfCurves}
 * @returns {object}
 */
export function motorLossCost({ exposure, rates = {} }) {
  if (!(exposure.totalVehicles > 0)) {
    return {
      available: false,
      unavailableReason: 'No vehicles. Motor rates per vehicle-year by category — enter the '
        + 'fleet schedule before pricing.',
      diagnostics: {},
    };
  }

  const curve = selectIlfCurve(rates.ilfCurves, {
    territory: exposure.territory, familyCode: FAMILY_CODE,
  });

  const tplOnly = exposure.coverBasis === 'TPL_ONLY';
  const priced = [];
  const unpriced = [];
  let lossCost = 0;
  let fallbacks = 0;
  let noCurveWhereNeeded = false;

  for (const group of exposure.fleet) {
    const count = num(group.count);
    const { rate, fellBackToWorldwide } = selectMotorRate(rates.motorBaseRates, {
      category: group.category, territory: exposure.territory,
    });
    if (!rate || !(count > 0)) {
      unpriced.push({
        vehicle_category: group.category,
        vehicle_count: count,
        reason: rate ? 'No vehicle count stated' : 'No rate loaded for this category',
      });
      continue;
    }
    if (fellBackToWorldwide) fallbacks += 1;

    // A TPL-only fleet carries no own-damage exposure, so the OD component
    // is nil — charging it would overstate the quote by the whole OD cost
    // per vehicle-year (F11).
    const odCost = tplOnly ? 0 : count * num(rate.od_cost_per_vehicle_year);
    const step = tplLimitFactor({
      limit: exposure.tplLimit, basicLimit: rate.tpl_basic_limit, curve,
    });
    if (step.basis === 'NO_CURVE_LOADED') noCurveWhereNeeded = true;
    const tplCost = count * num(rate.tpl_cost_per_vehicle_year) * step.factor;

    const groupCost = odCost + tplCost;
    lossCost += groupCost;
    priced.push({
      vehicle_category: group.category,
      vehicle_count: count,
      od_cost: odCost,
      tpl_cost: tplCost,
      tpl_limit_factor: step.factor,
      tpl_limit_basis: step.basis,
      loss_cost: groupCost,
      territory_fallback: fellBackToWorldwide,
    });
  }

  if (priced.length === 0) {
    return {
      available: false,
      unavailableReason: 'No motor base rate is loaded for any category on this fleet. Load the '
        + 'motor rate table before pricing.',
      diagnostics: { total_vehicles: exposure.totalVehicles, unpriced },
    };
  }

  // The no-claims adjustment is applied last and shown as its own line: it is
  // the underwriter's answer to the experience sitting beside this rate, and
  // burying it inside the rate would hide the negotiation.
  const ncd = exposure.ncdPct === null ? 0 : num(exposure.ncdPct);
  const beforeNcd = lossCost;
  lossCost *= (1 - ncd);

  const pricedVehicles = priced.reduce((t, g) => t + g.vehicle_count, 0);
  const warnings = [];
  if (unpriced.length > 0) {
    warnings.push(
      `${unpriced.length} of ${exposure.fleet.length} fleet groups could not be rated, covering `
      + `${exposure.totalVehicles - pricedVehicles} vehicles. The cost below is for the rated `
      + 'groups only.',
    );
  }
  if (noCurveWhereNeeded) {
    warnings.push(
      'A third-party limit is written above the rate\'s basic limit but no motor ILF curve is '
      + 'loaded, so the liability cost is the basic-limit cost. It understates the layer.',
    );
  }
  if (fallbacks > 0) warnings.push(`${fallbacks} group(s) fell back to a worldwide rate.`);
  if (ncd !== 0) {
    warnings.push(
      `A ${(ncd * 100).toFixed(1)}% fleet-rating adjustment is applied. It is a negotiated `
      + 'number, not a table value — the experience methods beside this are what justify it.',
    );
  }

  return {
    available: true,
    lossCost,
    // Per mille of the fleet's insured values where there are any; motor own
    // damage is written on values even though the cost is per vehicle-year.
    ratePm: exposure.totalSumInsured > 0
      ? (lossCost / exposure.totalSumInsured) * 1000
      : null,
    claimCount: null,
    diagnostics: {
      total_vehicles: exposure.totalVehicles,
      rated_vehicles: pricedVehicles,
      cover_basis: exposure.coverBasis,
      total_sum_insured: exposure.totalSumInsured,
      cost_per_vehicle_year: lossCost / (pricedVehicles || 1),
      groups: priced,
      unpriced,
      tpl_limit: exposure.tplLimit,
      curve: curve?.curve_code || null,
      loss_cost_before_ncd: beforeNcd,
      ncd_pct: ncd,
      warnings,
    },
  };
}

/**
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ section, rates = {} }) {
  return [{
    code: 'MOTOR_RATE',
    result: motorLossCost({ exposure: readExposure(section), rates }),
  }];
}

/** @type {import('../registry.js').FacFamily} */
export const motorFleet = {
  ...metaFor('MOTOR_FLEET'),
  readExposure,
  computeCandidates,
  // Own damage is written on the fleet's values even though the cost is per
  // vehicle-year, so the values are the base where there are any.
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + readExposure(s).totalSumInsured, 0,
  ),
};

export default motorFleet;
