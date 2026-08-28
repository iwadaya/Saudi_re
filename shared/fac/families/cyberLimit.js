// shared/fac/families/cyberLimit.js
//
// The CYBER_LIMIT rating family.
//
// Cyber has no sum insured and no exposure base in the sense the rest of the
// module means it: the loss is not proportional to revenue the way a fire loss
// is proportional to values. What revenue does is put an account in a band,
// and the band sets a rate PER MILLION OF LIMIT:
//
//   basicLimitLossCost = ratePerMillion × (basicLimit ÷ 1,000,000)
//                        × controlsFactor(posture)
//   lossCost           = basicLimitLossCost × [ ILF(D + L) − ILF(D) ]
//
// Note what that is NOT: the limit written divided by the basic limit. Cyber
// severity is nothing like linear in the limit, which is exactly what the ILF
// curve is for.
//
// The ILF step is the same machinery casualty uses (shared/fac/methods/
// ilfCurve.js), on a curve whose family_code is CYBER_LIMIT. A cyber tower
// does not obey a general-liability severity curve and must not borrow one —
// the curve selection enforces that.
//
// ── The aggregation gate ──────────────────────────────────────────────────
//
// A cyber portfolio's real exposure is not the sum of its limits. It is the
// largest common-vendor scenario: if a third of the book runs on one cloud
// region or one identity provider, a single outage is a single loss across
// all of them. The design makes dependency tagging a MANDATORY gate rather
// than an option (§4.4), and this family enforces the pricing half of it:
// an untagged risk does not price. The portfolio half — checking the book's
// exposure to the vendor before bind — lives in the accumulation service.
//
// Refusing to price an untagged risk is a deliberate choice about which
// failure is worse. A cyber price without a dependency tag looks complete and
// hides the only number that matters at portfolio level.
//
// fac_cyber_base_rate and fac_cyber_control_factor ship empty (migration 137).

import { ilfEvaluator, ilfLayerLossCost } from '../methods/ilfCurve.js';
import { selectIlfCurve } from './liabilityLimit.js';
import { num, numOrNull } from '../num.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'CYBER_LIMIT';

/** The controls a cyber posture is scored on. */
export const CONTROL_KEYS = [
  'MFA', 'EDR', 'BACKUPS', 'PATCHING', 'VENDOR_CONCENTRATION', 'TRAINING',
];

/**
 * @param {object|null} section
 * @returns {object}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  return {
    revenue: numOrNull(section?.exposure_base) ?? numOrNull(detail.revenue),
    industryCode: (detail.industry_code || 'ALL').toUpperCase(),
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    limit: numOrNull(section?.limit_amount) ?? numOrNull(detail.limit),
    attachment: num(section?.attachment ?? detail.attachment),
    recordsHeld: numOrNull(detail.records_held),
    controls: detail.controls && typeof detail.controls === 'object' ? detail.controls : {},
    // The dependency tags. Names only here; the portfolio check reads the
    // same values out of fac_cyber_dependency.
    dependencies: Array.isArray(detail.dependencies) ? detail.dependencies : [],
  };
}

/**
 * Pick the base rate for an industry and revenue band.
 *
 * Revenue bands are half-open. Industry falls back to ALL, which is a real
 * fallback rather than a fudge: a carrier that has not split its rates by
 * industry has one rate, and saying so is honest.
 *
 * @param {Array<object>} rates fac_cyber_base_rate rows
 * @param {{industryCode: string|null, revenue: number|null, territory: string|null}} args
 * @returns {{rate: object|null, fellBackToAllIndustries: boolean}}
 */
export function selectCyberRate(rates, { industryCode, revenue, territory }) {
  const value = numOrNull(revenue);
  const inBand = (r) => {
    const min = num(r.revenue_min);
    const max = numOrNull(r.revenue_max);
    return value !== null && value >= min && (max === null || value < max);
  };
  const territoryOk = (r) => !territory
    || (r.territory || 'WORLDWIDE').toUpperCase() === territory
    || (r.territory || 'WORLDWIDE').toUpperCase() === 'WORLDWIDE';

  const banded = (rates || []).filter((r) => inBand(r) && territoryOk(r));
  const exact = banded.find(
    (r) => (r.industry_code || 'ALL').toUpperCase() === (industryCode || 'ALL').toUpperCase(),
  );
  if (exact) return { rate: exact, fellBackToAllIndustries: false };
  const all = banded.find((r) => (r.industry_code || 'ALL').toUpperCase() === 'ALL');
  return { rate: all || null, fellBackToAllIndustries: Boolean(all) };
}

/**
 * The controls posture as a single multiplicative factor.
 *
 * A control with no loaded factor for its stated posture contributes nothing
 * and is reported. That matters more here than elsewhere: the controls factor
 * is the largest single discount on a cyber quote, and a silently-missing
 * factor would quietly price a poorly-controlled risk as an average one.
 *
 * @param {Array<object>} factors fac_cyber_control_factor rows
 * @param {object} controls {MFA: 'ENFORCED_ALL', EDR: 'NONE', …}
 * @returns {{factor: number, applied: object, missing: string[], scored: number}}
 */
export function resolveControlsFactor(factors, controls) {
  const rows = factors || [];
  const applied = {};
  const missing = [];
  let product = 1;
  let scored = 0;

  for (const key of CONTROL_KEYS) {
    const posture = controls?.[key] ?? controls?.[key.toLowerCase()];
    if (posture === null || posture === undefined || posture === '') continue;
    const row = rows.find(
      (f) => (f.control_key || '').toUpperCase() === key
        && String(f.posture).toUpperCase() === String(posture).toUpperCase(),
    );
    if (!row) { missing.push(`${key}=${posture}`); continue; }
    const f = num(row.factor);
    applied[key] = { posture: String(posture), factor: f, source: row.source || null };
    product *= f;
    scored += 1;
  }

  return { factor: product, applied, missing, scored };
}

/**
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {object} args.rates {cyberBaseRates, cyberControlFactors, ilfCurves}
 * @returns {object}
 */
export function cyberLossCost({ exposure, rates = {} }) {
  // The gate comes first, deliberately. Everything below it is arithmetic; a
  // price without a dependency tag is the thing that must not reach a screen.
  if (exposure.dependencies.length === 0) {
    return {
      available: false,
      unavailableReason: 'No critical vendor or cloud dependencies are tagged on this risk. '
        + 'Cyber accumulates through shared infrastructure, not through geography — an untagged '
        + 'risk cannot be checked against the book\'s common-vendor exposure, so it is not '
        + 'priced. Tag the dependencies on the section.',
      diagnostics: { gate: 'DEPENDENCIES_UNTAGGED' },
    };
  }

  const revenue = num(exposure.revenue);
  if (!(revenue > 0)) {
    return {
      available: false,
      unavailableReason: 'No revenue. Cyber rates per million of limit against a revenue band '
        + '— the revenue does not multiply the price, it selects the band.',
      diagnostics: {},
    };
  }
  if (!(num(exposure.limit) > 0)) {
    return {
      available: false,
      unavailableReason: 'No limit. A cyber loss cost is defined by its limit.',
      diagnostics: { revenue },
    };
  }

  const { rate, fellBackToAllIndustries } = selectCyberRate(rates.cyberBaseRates, {
    industryCode: exposure.industryCode, revenue, territory: exposure.territory,
  });
  if (!rate) {
    return {
      available: false,
      unavailableReason: `No cyber base rate is loaded for ${exposure.industryCode} at a revenue `
        + `of ${revenue.toLocaleString('en-US')}. Load the cyber rate table before pricing.`,
      diagnostics: { revenue, industry_code: exposure.industryCode },
    };
  }

  const curve = selectIlfCurve(rates.ilfCurves, {
    territory: exposure.territory, familyCode: FAMILY_CODE,
  });
  if (!curve) {
    return {
      available: false,
      unavailableReason: 'No cyber ILF curve is loaded. A cyber tower does not step like a '
        + 'general-liability one, so a GL curve is not borrowed for it — load a curve whose '
        + 'family is CYBER_LIMIT.',
      diagnostics: { revenue },
    };
  }

  const controls = resolveControlsFactor(rates.cyberControlFactors, exposure.controls);
  const basicLimit = num(rate.basic_limit);
  const basicLimitLossCost = (basicLimit / 1_000_000) * num(rate.rate_per_million)
    * controls.factor;

  const ILF = ilfEvaluator(curve);
  const lossCost = ilfLayerLossCost({
    basicLimitLossCost, attachment: exposure.attachment, limit: exposure.limit, ILF,
  });

  const warnings = [];
  if (controls.missing.length > 0) {
    warnings.push(
      `No control factor loaded for ${controls.missing.join(', ')} — treated as neutral. The `
      + 'controls factor is the largest single movement on a cyber quote; a missing one prices '
      + 'a poorly-controlled risk as an average one.',
    );
  }
  if (controls.scored === 0) {
    warnings.push('No controls posture scored at all — this is the untouched base rate.');
  }
  if (fellBackToAllIndustries && exposure.industryCode !== 'ALL') {
    warnings.push(`No ${exposure.industryCode} rate loaded — using the all-industries rate.`);
  }

  return {
    available: true,
    lossCost,
    // Per mille of revenue, which is the only common base a cyber rate can be
    // compared against across a book. The rate per million of limit is the
    // meaningful figure and is in the diagnostics.
    ratePm: (lossCost / revenue) * 1000,
    diagnostics: {
      revenue,
      industry_code: exposure.industryCode,
      industry_fallback: fellBackToAllIndustries,
      basic_limit: basicLimit,
      rate_per_million: num(rate.rate_per_million),
      controls_factor: controls.factor,
      controls_applied: controls.applied,
      controls_missing: controls.missing,
      basic_limit_loss_cost: basicLimitLossCost,
      curve: curve.curve_code || null,
      attachment: exposure.attachment,
      limit: num(exposure.limit),
      loss_cost_per_million: (lossCost / (num(exposure.limit) / 1_000_000)),
      dependencies: exposure.dependencies.map(
        (d) => (typeof d === 'string' ? d : d?.vendor_key || d?.vendorKey),
      ).filter(Boolean),
      source: rate.source || null,
      warnings,
    },
  };
}

/**
 * @param {object} args
 * @param {object|null} args.section
 * @param {object} [args.structure] {attachment, limit} — the placement being
 *   priced. On a non-proportional placement this is the reinsured layer, and
 *   it overrides the section's own attachment and limit exactly as
 *   liabilityLimit does: the burning-cost candidate in the same blend is
 *   already cut to this layer, and blending a whole-tower exposure rate
 *   against a layered experience rate averages incompatible quantities (F13).
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ section, structure = {}, rates = {} }) {
  const exposure = readExposure(section);
  return [{
    code: 'CYBER_RATE',
    result: cyberLossCost({
      exposure: {
        ...exposure,
        attachment: numOrNull(structure.attachment) ?? exposure.attachment,
        limit: numOrNull(structure.limit) ?? exposure.limit,
      },
      rates,
    }),
  }];
}

/** @type {import('../registry.js').FacFamily} */
export const cyberLimit = {
  ...metaFor('CYBER_LIMIT'),
  readExposure,
  computeCandidates,
  // Revenue is the only base a cyber rate can be compared against across a
  // book — it does not multiply the price, but it is what the ‰ is of.
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + (readExposure(s).revenue ?? 0), 0,
  ),
};

export default cyberLimit;
