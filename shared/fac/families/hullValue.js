// shared/fac/families/hullValue.js
//
// The HULL_VALUE rating family — Hull & Machinery, Hull War, Builders' Risk,
// Yachts and Fishing Vessels.
//
// Hull rates per mille of AGREED VALUE, not of a declared sum insured, and
// the rate is a base rate by vessel type and tonnage band moved by a short,
// well-established list of multiplicative factors:
//
//   rate‰ = base‰(vessel type, tonnage band)
//           × age × class × flag × trading area × management × claims record
//
//   lossCost = agreedValue × rate‰ ÷ 1000
//              + increased-value / disbursements load
//              − laid-up return
//
// Every factor is loaded from `fac_hull_factor`. A factor that is not loaded
// is 1.0 and is reported as not applied — the module never invents an age or
// classification loading, because a vessel's age curve is exactly the kind of
// carrier-specific view that has to be owned by somebody.
//
// War & strikes is a separate section, priced by `transitValues.warSectionLossCost`
// against the same agreed value. It is not a percentage on the hull rate:
// hull war rates move weekly and by hundreds of percent when a corridor
// closes, and burying that inside the H&M rate hides the number that moved
// (design doc §4, `HULL_VALUE`).

import { num, numOrNull } from '../num.js';
import { selectWarRate, warSectionLossCost } from './transitValues.js';

export const FAMILY_CODE = 'HULL_VALUE';

/** The factor kinds `fac_hull_factor` carries, in the order they are applied. */
export const FACTOR_KINDS = ['AGE', 'CLASS', 'FLAG', 'TRADING_AREA', 'MANAGEMENT', 'CLAIMS'];

/**
 * Read the vessel off a section.
 *
 * @param {object|null} section fac_risk_section row
 * @returns {object}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  return {
    agreedValue: numOrNull(section?.sum_insured) ?? numOrNull(detail.agreed_value),
    vesselType: (detail.vessel_type || '').toUpperCase() || null,
    tonnage: numOrNull(detail.tonnage),
    buildYear: numOrNull(detail.build_year),
    age: numOrNull(detail.age),
    classSociety: (detail.class_society || '').toUpperCase() || null,
    flag: (detail.flag || '').toUpperCase() || null,
    tradingArea: (detail.trading_area || '').toUpperCase() || null,
    management: (detail.management || '').toUpperCase() || null,
    claimsBand: (detail.claims_band || '').toUpperCase() || null,
    increasedValue: numOrNull(detail.increased_value),
    increasedValueRatePm: numOrNull(detail.increased_value_rate_pm),
    laidUpDays: numOrNull(detail.laid_up_days),
    laidUpReturnPct: numOrNull(detail.laid_up_return_pct),
    warRegion: (detail.war_region || '').toUpperCase() || null,
    breachOfWarranty: Boolean(detail.breach_of_warranty),
  };
}

/**
 * Vessel age, from an explicit age or a build year and the period of cover.
 *
 * @param {{age: number|null, buildYear: number|null}} exposure
 * @param {string|Date|null} [inceptionDate]
 * @returns {number|null}
 */
export function vesselAge(exposure, inceptionDate) {
  if (exposure.age !== null && exposure.age !== undefined) return num(exposure.age);
  const build = numOrNull(exposure.buildYear);
  if (build === null) return null;
  const inception = inceptionDate ? new Date(inceptionDate) : null;
  const year = inception && !Number.isNaN(inception.getTime())
    ? inception.getUTCFullYear()
    : null;
  if (year === null) return null;
  return Math.max(year - build, 0);
}

/**
 * Pick the base rate for a vessel type and tonnage.
 *
 * Tonnage bands are half-open — `tonnage_min` inclusive, `tonnage_max`
 * exclusive, NULL max meaning open-ended — so adjacent bands from a table
 * cannot both match and cannot leave a gap at the boundary.
 *
 * @param {Array<object>} rates fac_hull_base_rate rows
 * @param {{vesselType: string|null, tonnage: number|null}} args
 * @returns {object|null}
 */
export function selectHullRate(rates, { vesselType, tonnage }) {
  const pool = (rates || []).filter(
    (r) => (r.vessel_type || '').toUpperCase() === (vesselType || '').toUpperCase(),
  );
  if (pool.length === 0) return null;
  const t = numOrNull(tonnage);
  if (t === null) return null;
  return pool.find((r) => {
    const min = num(r.tonnage_min);
    const max = numOrNull(r.tonnage_max);
    return t >= min && (max === null || t < max);
  }) || null;
}

/**
 * Resolve the rating factors that apply, and say which did not.
 *
 * @param {Array<object>} factors fac_hull_factor rows
 * @param {object} keys {AGE, CLASS, FLAG, TRADING_AREA, MANAGEMENT, CLAIMS}
 * @returns {{factor: number, applied: object, missing: string[]}}
 */
export function resolveHullFactors(factors, keys) {
  const rows = factors || [];
  const applied = {};
  const missing = [];
  let product = 1;

  for (const kind of FACTOR_KINDS) {
    const key = keys[kind];
    if (key === null || key === undefined || key === '') continue;
    const row = rows.find(
      (f) => (f.factor_kind || '').toUpperCase() === kind
        && String(f.factor_key).toUpperCase() === String(key).toUpperCase(),
    );
    if (!row) {
      missing.push(`${kind}=${key}`);
      continue;
    }
    const f = num(row.factor);
    applied[kind] = { key: String(key), factor: f, source: row.source || null };
    product *= f;
  }

  return { factor: product, applied, missing };
}

/**
 * Which loaded AGE band a vessel's age falls in.
 *
 * Age bands are written as keys like "0-5", "6-10", "20+". Nothing else is
 * guessed: an age with no band loaded contributes no factor.
 *
 * @param {Array<object>} factors
 * @param {number|null} age
 * @returns {string|null} the band key, or null
 */
export function ageBandKey(factors, age) {
  if (age === null || age === undefined) return null;
  const a = num(age);
  const bands = (factors || []).filter((f) => (f.factor_kind || '').toUpperCase() === 'AGE');
  for (const band of bands) {
    const key = String(band.factor_key);
    const open = key.match(/^(\d+(?:\.\d+)?)\s*\+$/);
    if (open) {
      if (a >= Number(open[1])) return key;
      continue;
    }
    const range = key.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/);
    if (range && a >= Number(range[1]) && a <= Number(range[2])) return key;
  }
  return null;
}

/**
 * The hull loss cost.
 *
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {Array<object>} args.hullRates
 * @param {Array<object>} args.hullFactors
 * @param {string|Date|null} [args.inceptionDate]
 * @returns {{available: boolean, unavailableReason?: string, lossCost?: number,
 *            ratePm?: number, diagnostics: object}}
 */
export function hullLossCost({ exposure, hullRates, hullFactors, inceptionDate = null }) {
  const value = num(exposure.agreedValue);
  if (!(value > 0)) {
    return {
      available: false,
      unavailableReason: 'No agreed value. Hull rates per mille of the agreed value — enter it '
        + 'on the section before pricing.',
      diagnostics: {},
    };
  }
  if (!exposure.vesselType) {
    return {
      available: false,
      unavailableReason: 'No vessel type. The base rate is by vessel type and tonnage band.',
      diagnostics: { agreed_value: value },
    };
  }
  if (exposure.tonnage === null) {
    return {
      available: false,
      unavailableReason: 'No tonnage. The base rate is by vessel type and tonnage band, so a '
        + 'tonnage is needed to pick the band.',
      diagnostics: { agreed_value: value, vessel_type: exposure.vesselType },
    };
  }

  const rate = selectHullRate(hullRates, {
    vesselType: exposure.vesselType, tonnage: exposure.tonnage,
  });
  if (!rate) {
    return {
      available: false,
      unavailableReason: `No hull base rate is loaded for ${exposure.vesselType} at `
        + `${exposure.tonnage} tons. Load the hull rate table before pricing.`,
      diagnostics: { agreed_value: value, vessel_type: exposure.vesselType, tonnage: exposure.tonnage },
    };
  }

  const age = vesselAge(exposure, inceptionDate);
  const { factor, applied, missing } = resolveHullFactors(hullFactors, {
    AGE: ageBandKey(hullFactors, age),
    CLASS: exposure.classSociety,
    FLAG: exposure.flag,
    TRADING_AREA: exposure.tradingArea,
    MANAGEMENT: exposure.management,
    CLAIMS: exposure.claimsBand,
  });

  const baseRatePm = num(rate.rate_pm);
  const ratePm = baseRatePm * factor;
  let lossCost = (value * ratePm) / 1000;

  // Increased value / disbursements sits above the hull value and is rated
  // on its own; absent a rate for it, it is not priced and is reported.
  const iv = num(exposure.increasedValue);
  const ivRate = numOrNull(exposure.increasedValueRatePm);
  let ivLoss = 0;
  if (iv > 0 && ivRate !== null) {
    ivLoss = (iv * ivRate) / 1000;
    lossCost += ivLoss;
  }

  // Laid-up returns: a vessel out of commission for a stated period earns a
  // return of premium on that period, pro rata as to time.
  const laidUpDays = num(exposure.laidUpDays);
  const laidUpPct = numOrNull(exposure.laidUpReturnPct);
  let laidUpReturn = 0;
  if (laidUpDays > 0 && laidUpPct !== null) {
    laidUpReturn = lossCost * (laidUpDays / 365) * laidUpPct;
    lossCost -= laidUpReturn;
  }

  const warnings = [];
  if (missing.length > 0) {
    warnings.push(
      `No factor loaded for ${missing.join(', ')} — treated as 1.00. A vessel's age and class `
      + 'curves are a carrier view; load them rather than relying on the neutral default.',
    );
  }
  if (age === null) {
    warnings.push('No vessel age or build year — no age factor applied.');
  }
  if (iv > 0 && ivRate === null) {
    warnings.push('Increased value is stated but no IV rate is set — IV is not priced.');
  }
  if (laidUpDays > 0 && laidUpPct === null) {
    warnings.push('Laid-up days are stated but no laid-up return percentage is set — no return '
      + 'allowed.');
  }

  return {
    available: true,
    lossCost,
    ratePm: (lossCost / value) * 1000,
    diagnostics: {
      agreed_value: value,
      vessel_type: exposure.vesselType,
      tonnage: exposure.tonnage,
      tonnage_band: `${num(rate.tonnage_min)}–${rate.tonnage_max === null || rate.tonnage_max === undefined ? '∞' : num(rate.tonnage_max)}`,
      base_rate_pm: baseRatePm,
      factor_product: factor,
      hull_rate_pm: ratePm,
      age,
      factors_applied: applied,
      factors_missing: missing,
      increased_value_loss_cost: ivLoss,
      laid_up_return: laidUpReturn,
      source: rate.source || null,
      warnings,
    },
  };
}

/**
 * @param {object} args
 * @param {object|null} args.section
 * @param {object} args.risk
 * @param {object} args.rates {hullRates, hullFactors, warRates}
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ risk, section, rates = {} }) {
  const exposure = readExposure(section);
  const candidates = [{
    code: 'HULL_RATE',
    result: hullLossCost({
      exposure,
      hullRates: rates.hullRates,
      hullFactors: rates.hullFactors,
      inceptionDate: risk?.period_from || risk?.inception_date || null,
    }),
  }];

  if (exposure.warRegion) {
    candidates.push({
      code: 'WAR_SECTION',
      result: warSectionLossCost({
        insuredValue: exposure.agreedValue,
        warRate: selectWarRate(rates.warRates, { region: exposure.warRegion, basis: 'ANNUAL' }),
        breachOfWarranty: exposure.breachOfWarranty,
      }),
    });
  }

  return candidates;
}

/** @type {import('../registry.js').FacFamily} */
export const hullValue = {
  code: FAMILY_CODE,
  label: 'Hull & Marine Assets',
  segment: 'MARINE_TRANSIT',
  ratingBasis: 'AGREED_VALUE',
  periodBasis: 'ANNUAL',
  methods: ['HULL_RATE', 'BURNING_COST', 'BENCHMARK'],
  // A single vessel's own record is thin; a fleet's is not. k sits between
  // property and casualty and the cap is the property cap.
  credibility: { k: 8, maxZ: 0.70, unit: 'CLAIM_COUNT' },
  requires: [],
  wizardSteps: [],
  implemented: true,
  exposureFields: [
    { key: 'agreed_value', label: 'Agreed value', type: 'money', required: true },
    { key: 'vessel_type', label: 'Vessel type', type: 'text', required: true },
    { key: 'tonnage', label: 'Tonnage (GT)', type: 'number', required: true },
    { key: 'build_year', label: 'Year built', type: 'integer' },
    { key: 'class_society', label: 'Classification society', type: 'text' },
    { key: 'flag', label: 'Flag', type: 'text' },
    { key: 'trading_area', label: 'Trading area', type: 'text' },
    { key: 'management', label: 'Management (ISM/DOC)', type: 'text' },
    { key: 'claims_band', label: 'Claims record band', type: 'text' },
    { key: 'increased_value', label: 'Increased value / disbursements', type: 'money' },
    { key: 'increased_value_rate_pm', label: 'IV rate ‰', type: 'rate' },
    { key: 'laid_up_days', label: 'Laid-up days', type: 'integer' },
    { key: 'laid_up_return_pct', label: 'Laid-up return', type: 'percent' },
    { key: 'war_region', label: 'War region', type: 'text' },
    { key: 'breach_of_warranty', label: 'Breach of warranty (listed areas)', type: 'boolean' },
  ],
  readExposure,
  computeCandidates,
};

export default hullValue;
