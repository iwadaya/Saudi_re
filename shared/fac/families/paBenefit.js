// shared/fac/families/paBenefit.js
//
// The PA_BENEFIT rating family — Personal Accident, Group Personal Accident,
// Workmen's Compensation written on a benefit basis.
//
//   lossCost = Σ_classes  headcount_c × benefitUnits_c
//                         × ratePerUnit(occupational class, cover basis)
//
// A "benefit unit" is whatever the scheme's schedule says — commonly annual
// salary multiples for death and permanent total disablement, with weekly
// benefit for temporary disablement priced separately. The family does not
// try to normalise across schemes; it rates the units the schedule states,
// against a rate quoted per unit.
//
// Two things move the rate materially and both are in the key:
//
//   • **Occupational class.** A class 4 (heavy manual, working at height) is a
//     multiple of a class 1 (clerical), not a loading on it.
//   • **Cover basis.** 24-hour cover includes the commute, the football match
//     and the holiday. Occupational-only does not. It is roughly a doubling in
//     exposure and is never a percentage adjustment.
//
// ── The accumulation that matters ─────────────────────────────────────────
//
// PA's binding constraint is not the annual rate; it is the one-event limit.
// A scheme with 400 members has a plausible annual cost and an implausible
// worst case if 30 of them share a bus. The family carries the one-event
// exposure — largest single conveyance or location — into the diagnostics so
// the capacity check bites on it, exactly as cargo carries the maximum
// any-one-conveyance limit.
//
// fac_pa_base_rate ships empty (migration 137).

import { num, numOrNull } from '../num.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'PA_BENEFIT';

export const COVER_BASES = ['24_HOUR', 'OCCUPATIONAL'];

/**
 * @param {object|null} section
 * @returns {object}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  const raw = Array.isArray(detail.classes) && detail.classes.length > 0
    ? detail.classes
    : [{
      occupational_class: detail.occupational_class || null,
      headcount: numOrNull(section?.exposure_base) ?? numOrNull(detail.headcount),
      benefit_units: numOrNull(detail.benefit_units),
    }];

  const classes = raw.map((c) => ({
    occupationalClass: String(c.occupational_class ?? c.occupationalClass ?? '').toUpperCase()
      || null,
    headcount: numOrNull(c.headcount),
    benefitUnits: numOrNull(c.benefit_units ?? c.benefitUnits),
    description: c.description || null,
  }));

  const coverBasis = (detail.cover_basis || '24_HOUR').toUpperCase();

  return {
    classes,
    coverBasis,
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    totalHeadcount: classes.reduce((t, c) => t + num(c.headcount), 0),
    totalBenefit: classes.reduce((t, c) => t + num(c.headcount) * num(c.benefitUnits), 0),
    // The one-event exposure, which is what actually limits the line.
    maxOneEventHeadcount: numOrNull(detail.max_one_event_headcount),
    catLimit: numOrNull(section?.limit_amount) ?? numOrNull(detail.cat_limit),
  };
}

/**
 * @param {Array<object>} rates fac_pa_base_rate rows
 * @param {{occupationalClass: string|null, coverBasis: string, territory: string|null}} args
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function selectPaRate(rates, { occupationalClass, coverBasis, territory }) {
  // Cover basis is never relaxed: 24-hour cover is roughly twice the exposure
  // of occupational-only, so substituting one for the other is not a fallback,
  // it is a different price.
  const pool = (rates || []).filter(
    (r) => String(r.occupational_class).toUpperCase() === String(occupationalClass).toUpperCase()
      && (r.cover_basis || '24_HOUR').toUpperCase() === (coverBasis || '24_HOUR').toUpperCase(),
  );
  const exact = pool.find(
    (r) => (r.territory || '').toUpperCase() === (territory || '').toUpperCase(),
  );
  if (exact) return { rate: exact, fellBackToWorldwide: false };
  const worldwide = pool.find((r) => (r.territory || '').toUpperCase() === 'WORLDWIDE');
  return { rate: worldwide || null, fellBackToWorldwide: Boolean(worldwide) };
}

/**
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {object} args.rates {paBaseRates}
 * @returns {object}
 */
export function paLossCost({ exposure, rates = {} }) {
  if (!(exposure.totalHeadcount > 0)) {
    return {
      available: false,
      unavailableReason: 'No members. Personal accident rates per benefit unit per member — '
        + 'enter the scheme schedule before pricing.',
      diagnostics: {},
    };
  }
  if (!COVER_BASES.includes(exposure.coverBasis)) {
    return {
      available: false,
      unavailableReason: `Cover basis "${exposure.coverBasis}" is not one this family rates. `
        + '24-hour and occupational-only are different covers, not variants of one.',
      diagnostics: { cover_basis: exposure.coverBasis },
    };
  }

  const priced = [];
  const unpriced = [];
  let lossCost = 0;
  let fallbacks = 0;

  for (const group of exposure.classes) {
    const headcount = num(group.headcount);
    const units = num(group.benefitUnits);
    const { rate, fellBackToWorldwide } = selectPaRate(rates.paBaseRates, {
      occupationalClass: group.occupationalClass,
      coverBasis: exposure.coverBasis,
      territory: exposure.territory,
    });
    if (!rate || !(headcount > 0) || !(units > 0)) {
      unpriced.push({
        occupational_class: group.occupationalClass,
        headcount,
        benefit_units: units,
        reason: !rate
          ? `No rate loaded for class ${group.occupationalClass} on a ${exposure.coverBasis} basis`
          : 'No headcount or benefit units stated',
      });
      continue;
    }
    if (fellBackToWorldwide) fallbacks += 1;

    const benefit = headcount * units;
    const cost = benefit * num(rate.rate_per_unit);
    lossCost += cost;
    priced.push({
      occupational_class: group.occupationalClass,
      headcount,
      benefit_units: units,
      total_benefit: benefit,
      rate_per_unit: num(rate.rate_per_unit),
      loss_cost: cost,
      territory_fallback: fellBackToWorldwide,
    });
  }

  if (priced.length === 0) {
    return {
      available: false,
      unavailableReason: `No PA base rate is loaded for any occupational class on this scheme, `
        + `on a ${exposure.coverBasis} basis. Load the PA rate table before pricing.`,
      diagnostics: { total_headcount: exposure.totalHeadcount, unpriced },
    };
  }

  const pricedHeadcount = priced.reduce((t, g) => t + g.headcount, 0);
  const pricedBenefit = priced.reduce((t, g) => t + g.total_benefit, 0);

  const warnings = [];
  if (unpriced.length > 0) {
    warnings.push(
      `${unpriced.length} of ${exposure.classes.length} occupational classes could not be rated, `
      + `covering ${exposure.totalHeadcount - pricedHeadcount} members.`,
    );
  }
  if (fallbacks > 0) warnings.push(`${fallbacks} class(es) fell back to a worldwide rate.`);
  if (exposure.maxOneEventHeadcount === null) {
    warnings.push(
      'No one-event exposure stated. The annual rate is not what limits a PA line — the '
      + 'accumulation is, when a group travels together. State the largest number of members '
      + 'exposed to one event.',
    );
  }

  return {
    available: true,
    lossCost,
    // Per mille of the total benefit at risk, which is the sum insured
    // equivalent for a benefit scheme.
    ratePm: exposure.totalBenefit > 0 ? (lossCost / exposure.totalBenefit) * 1000 : null,
    diagnostics: {
      total_headcount: exposure.totalHeadcount,
      rated_headcount: pricedHeadcount,
      total_benefit: exposure.totalBenefit,
      rated_benefit: pricedBenefit,
      cover_basis: exposure.coverBasis,
      classes: priced,
      unpriced,
      // Carried for the capacity check, not for the rate.
      max_one_event_headcount: exposure.maxOneEventHeadcount,
      cat_limit: exposure.catLimit,
      one_event_benefit: exposure.maxOneEventHeadcount !== null && pricedHeadcount > 0
        ? (pricedBenefit / pricedHeadcount) * exposure.maxOneEventHeadcount
        : null,
      warnings,
    },
  };
}

/**
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ section, rates = {} }) {
  return [{
    code: 'PA_RATE',
    result: paLossCost({ exposure: readExposure(section), rates }),
  }];
}

/** @type {import('../registry.js').FacFamily} */
export const paBenefit = {
  ...metaFor('PA_BENEFIT'),
  readExposure,
  computeCandidates,
  // Total benefit at risk — headcount × benefit units — is a benefit
  // scheme's sum-insured equivalent.
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + readExposure(s).totalBenefit, 0,
  ),
};

export default paBenefit;
