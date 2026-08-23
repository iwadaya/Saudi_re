// shared/fac/families/projectWorks.js
//
// The PROJECT_WORKS rating family — Contractors' All Risks, Erection All
// Risks, offshore construction and standalone project cargo's civil cousin.
//
// This family exists because construction is the one class in the module that
// is not an annual policy on a sum insured. A CAR slip covers a whole project
// period — twelve months, thirty-six, sometimes sixty — for a single premium
// payable at inception, rated on the TOTAL CONTRACT VALUE. Handing it to the
// property engine (which is what happened before the taxonomy landed) asks it
// for an occupancy code it does not have and produces an annual rate on a sum
// insured it does not have either.
//
//   worksLossCost = contractValue
//                 × baseRate‰(project type, value band, territory)
//                 × (1 + Σ project factors)
//                 × periodFactor(months)
//                 ÷ 1000
//
//   + testingLoad(weeks)        the riskiest weeks of the whole project
//   + maintenanceLoad(months)   defects liability after handover
//   + dsuLoad(indemnity months) delay in start-up — the financial loss behind
//                               the physical one, and often the larger number
//
// Testing, maintenance and DSU are separate covers with separate exposure, so
// they are separately rated and shown as their own lines. A percentage loading
// on the works rate would hide the fact that a four-week wet commissioning on
// a power plant is most of the risk.
//
// The project factors are ADDITIVE — base × (1 + Σ loadings) — because that is
// how a construction slip is built up and negotiated. Contrast with hull,
// where the factors are multiplicative. Neither is a house style; each is what
// the market does for that class.
//
// Everything is loaded: fac_project_base_rate, fac_project_factor and
// fac_project_load_rate all ship empty (migration 137).

import { num, numOrNull } from '../num.js';
import { pickByTerritory } from '../rateSelect.js';
import { projectPeriodFactor, periodMonths, EARNING_PATTERNS } from '../period.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'PROJECT_WORKS';

/** The factor kinds fac_project_factor carries, in the order they are summed. */
export const FACTOR_KINDS = ['CONTRACTOR', 'METHOD', 'GROUND', 'WET_RISK', 'PHASING', 'SECURITY'];

/** The separately-rated covers beyond the works itself. */
export const LOAD_KINDS = ['TESTING', 'MAINTENANCE', 'DSU'];

/**
 * Read the project off a section.
 *
 * @param {object|null} section fac_risk_section row
 * @param {object|null} risk
 * @returns {object}
 */
export function readExposure(section, risk) {
  const detail = section?.exposure_detail || {};
  return {
    contractValue: numOrNull(section?.sum_insured)
      ?? numOrNull(section?.exposure_base)
      ?? numOrNull(detail.contract_value),
    projectType: (detail.project_type || '').toUpperCase() || null,
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    months: numOrNull(detail.period_months) ?? periodMonths(risk),
    // Works split. Not used to rate today — one base rate covers the works —
    // but carried because it is what an underwriter needs to see beside the
    // rate, and what a civil/plant split will rate on when it is built.
    civilValue: numOrNull(detail.civil_value),
    plantValue: numOrNull(detail.plant_value),
    permanentWorksValue: numOrNull(detail.permanent_works_value),
    testingWeeks: numOrNull(detail.testing_weeks),
    maintenanceMonths: numOrNull(detail.maintenance_months),
    maintenanceType: (detail.maintenance_type || 'DEFAULT').toUpperCase(),
    dsuMonths: numOrNull(detail.dsu_indemnity_months),
    dsuSumInsured: numOrNull(detail.dsu_sum_insured),
    dsuProfile: (detail.dsu_profile || 'DEFAULT').toUpperCase(),
    factors: detail.factors && typeof detail.factors === 'object' ? detail.factors : {},
    earningPattern: (risk?.earning_pattern || detail.earning_pattern || 'STRAIGHT_LINE')
      .toUpperCase(),
  };
}

/**
 * Pick the base rate for a project type, territory and contract-value band.
 *
 * Value bands are half-open — min inclusive, max exclusive, NULL max
 * open-ended — so adjacent bands cannot both match and cannot leave a gap.
 *
 * @param {Array<object>} rates fac_project_base_rate rows
 * @param {{projectType: string|null, territory: string|null, contractValue: number|null}} args
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function selectProjectRate(rates, { projectType, territory, contractValue }) {
  const value = numOrNull(contractValue);
  const inBand = (r) => {
    const min = num(r.contract_value_min);
    const max = numOrNull(r.contract_value_max);
    return value !== null && value >= min && (max === null || value < max);
  };
  const forType = (rates || []).filter(
    (r) => (r.project_type || '').toUpperCase() === (projectType || '').toUpperCase() && inBand(r),
  );
  return pickByTerritory(forType, territory);
}

/**
 * Sum the project factors that are loaded, and report the ones that are not.
 *
 * @param {Array<object>} factors fac_project_factor rows
 * @param {object} selections {CONTRACTOR: 'TIER_1', GROUND: 'ALLUVIAL', …}
 * @returns {{total: number, applied: object, missing: string[]}}
 */
export function resolveProjectFactors(factors, selections) {
  const rows = factors || [];
  const applied = {};
  const missing = [];
  let total = 0;

  for (const kind of FACTOR_KINDS) {
    const key = selections?.[kind] ?? selections?.[kind.toLowerCase()];
    if (key === null || key === undefined || key === '') continue;
    const row = rows.find(
      (f) => (f.factor_kind || '').toUpperCase() === kind
        && String(f.factor_key).toUpperCase() === String(key).toUpperCase(),
    );
    if (!row) {
      missing.push(`${kind}=${key}`);
      continue;
    }
    const loading = num(row.loading);
    applied[kind] = { key: String(key), loading, source: row.source || null };
    total += loading;
  }

  return { total, applied, missing };
}

/**
 * One separately-rated cover on top of the works.
 *
 * @param {Array<object>} loadRates fac_project_load_rate rows
 * @param {object} args {kind, key, base, units}
 * @returns {{lossCost: number, rate: object|null, unitsUsed: number}|null}
 */
export function loadCost(loadRates, { kind, key = 'DEFAULT', base, units }) {
  const row = (loadRates || []).find(
    (r) => (r.load_kind || '').toUpperCase() === kind
      && String(r.load_key || 'DEFAULT').toUpperCase() === String(key || 'DEFAULT').toUpperCase(),
  ) || (loadRates || []).find(
    (r) => (r.load_kind || '').toUpperCase() === kind
      && String(r.load_key || 'DEFAULT').toUpperCase() === 'DEFAULT',
  );
  if (!row) return null;
  const amount = num(base);
  if (!(amount > 0)) return null;
  const perUnit = (row.per_unit || 'FLAT').toUpperCase();
  // FLAT means the rate covers the cover, however long it runs. WEEK and
  // MONTH multiply by the duration — a twelve-week commissioning is three
  // times the exposure of a four-week one, and the slip prices it that way.
  const multiplier = perUnit === 'FLAT' ? 1 : Math.max(num(units), 0);
  if (perUnit !== 'FLAT' && !(multiplier > 0)) return null;
  return {
    lossCost: (amount * num(row.rate_pm)) / 1000 * multiplier,
    rate: row,
    unitsUsed: multiplier,
  };
}

/**
 * The works loss cost, with its separately-rated covers.
 *
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {object} args.rates {projectBaseRates, projectFactors, projectLoadRates}
 * @returns {object}
 */
export function projectLossCost({ exposure, rates = {} }) {
  const value = num(exposure.contractValue);
  if (!(value > 0)) {
    return {
      available: false,
      unavailableReason: 'No contract value. A project rates per mille of the total contract '
        + 'value for the whole period, not on an annual sum insured.',
      diagnostics: {},
    };
  }
  if (!exposure.projectType) {
    return {
      available: false,
      unavailableReason: 'No project type. The base rate is by project type, value band and '
        + 'territory.',
      diagnostics: { contract_value: value },
    };
  }

  const { rate, fellBackToWorldwide } = selectProjectRate(rates.projectBaseRates, {
    projectType: exposure.projectType,
    territory: exposure.territory,
    contractValue: value,
  });
  if (!rate) {
    return {
      available: false,
      unavailableReason: `No project base rate is loaded for ${exposure.projectType} at a `
        + `contract value of ${value.toLocaleString('en-US')}. Load the project rate table `
        + 'before pricing.',
      diagnostics: { contract_value: value, project_type: exposure.projectType },
    };
  }

  const factors = resolveProjectFactors(rates.projectFactors, exposure.factors);
  const period = projectPeriodFactor({
    months: exposure.months,
    perMonth: rate.period_factor_per_month,
    baselineMonths: numOrNull(rate.period_baseline_months) ?? 12,
  });

  const baseRatePm = num(rate.rate_pm);
  const worksRatePm = baseRatePm * (1 + factors.total) * period.factor;
  const worksLossCost = (value * worksRatePm) / 1000;

  // ── The separately-rated covers ────────────────────────────────────
  const testing = loadCost(rates.projectLoadRates, {
    kind: 'TESTING', base: exposure.plantValue ?? value, units: exposure.testingWeeks,
  });
  const maintenance = loadCost(rates.projectLoadRates, {
    kind: 'MAINTENANCE', key: exposure.maintenanceType,
    base: value, units: exposure.maintenanceMonths,
  });
  const dsu = loadCost(rates.projectLoadRates, {
    kind: 'DSU', key: exposure.dsuProfile,
    base: exposure.dsuSumInsured, units: exposure.dsuMonths,
  });

  const extras = [
    ['TESTING', testing], ['MAINTENANCE', maintenance], ['DSU', dsu],
  ].filter(([, r]) => r !== null);
  const extrasCost = extras.reduce((t, [, r]) => t + r.lossCost, 0);

  const warnings = [];
  if (!period.applied && num(exposure.months) > 12) {
    warnings.push(
      `This is a ${exposure.months}-month project and no period loading is loaded for this `
      + 'rate, so it is priced as if it ran for the baseline period. Load '
      + 'period_factor_per_month, or the rate understates a long project.',
    );
  }
  if (exposure.months === null) {
    warnings.push('No project period. Set the inception and expiry dates, or the period in '
      + 'months, before this rate means anything.');
  }
  if (factors.missing.length > 0) {
    warnings.push(`No loading loaded for ${factors.missing.join(', ')} — treated as zero.`);
  }
  if (num(exposure.testingWeeks) > 0 && !testing) {
    warnings.push('Testing & commissioning weeks are stated but no testing rate is loaded — '
      + 'the riskiest weeks of the project are not in this price.');
  }
  if (num(exposure.maintenanceMonths) > 0 && !maintenance) {
    warnings.push('A maintenance period is stated but no maintenance rate is loaded.');
  }
  if (num(exposure.dsuSumInsured) > 0 && !dsu) {
    warnings.push('DSU is stated but no DSU rate is loaded — the delay cover, often the larger '
      + 'exposure, is not in this price.');
  }
  if (fellBackToWorldwide && exposure.territory !== 'WORLDWIDE') {
    warnings.push(`No ${exposure.territory} rate loaded — using the worldwide rate.`);
  }
  if (!EARNING_PATTERNS.includes(exposure.earningPattern)) {
    warnings.push(`Unknown earning pattern "${exposure.earningPattern}" — the portfolio view `
      + 'will earn this straight-line.');
  }

  const lossCost = worksLossCost + extrasCost;

  return {
    available: true,
    lossCost,
    // Per mille of contract value, over the whole period. It is not an
    // annual rate and must never be annualised by anything downstream.
    ratePm: (lossCost / value) * 1000,
    diagnostics: {
      contract_value: value,
      project_type: exposure.projectType,
      territory: exposure.territory,
      territory_fallback: fellBackToWorldwide,
      period_months: exposure.months,
      base_rate_pm: baseRatePm,
      factor_total: factors.total,
      factors_applied: factors.applied,
      factors_missing: factors.missing,
      period_factor: period.factor,
      period_basis: period.basis,
      works_rate_pm: worksRatePm,
      works_loss_cost: worksLossCost,
      extras: extras.map(([kind, r]) => ({
        kind,
        loss_cost: r.lossCost,
        rate_pm: num(r.rate.rate_pm),
        per_unit: r.rate.per_unit,
        units: r.unitsUsed,
        source: r.rate.source || null,
      })),
      extras_loss_cost: extrasCost,
      earning_pattern: exposure.earningPattern,
      period_basis_note: 'Rate is for the whole project period, not per annum.',
      source: rate.source || null,
      warnings,
    },
  };
}

/**
 * @param {object} args
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ risk, section, rates = {} }) {
  const exposure = readExposure(section, risk);
  return [{ code: 'PROJECT_RATE', result: projectLossCost({ exposure, rates }) }];
}

/** @type {import('../registry.js').FacFamily} */
export const projectWorks = {
  ...metaFor('PROJECT_WORKS'),
  readExposure,
  computeCandidates,
  premiumBase: ({ sections, risk }) => (sections || []).reduce(
    (t, s) => t + (readExposure(s, risk).contractValue ?? 0), 0,
  ),
};

export default projectWorks;
