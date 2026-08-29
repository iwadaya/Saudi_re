// shared/fac/families/liabilityLimit.js
//
// The LIABILITY_LIMIT rating family — General and Public Liability, Products,
// Employers' Liability, Professional Indemnity, D&O, Medical Malpractice,
// Environmental, and the financial lines that price the same way (Fidelity,
// Crime, Financial Lines). Marine Liability uses these mechanics with a
// marine ILF curve.
//
// This is the largest gap the redesign found. Every one of these classes
// reached the property engine, which asked for an occupancy code and a NatCat
// zone, threw when it did not get them, and left the screen showing a stack
// message in red (findings F1, F2). There is no sum insured to rate against
// and never was.
//
// What replaces it:
//
//   basicLimitLossCost = exposureBase / basisDivisor × lossCostPerUnit
//   lossCost           = basicLimitLossCost × [ ILF(D + L) − ILF(D) ]
//                        × claimsMadeStep × defenceCosts × aggregates
//
// The exposure base is turnover, payroll, fee income or units — whichever the
// class actually rates on, which is why the base-rate row carries its own
// `basis_unit`. A rate quoted against the wrong unit is silently wrong by an
// order of magnitude, so the family refuses to guess: if the section's stated
// unit and the rate's unit disagree, it says so and does not price.
//
// The rates and curves are loaded, never shipped — see
// docs/facultative-pricing-design.md §8 and shared/fac/methods/ilfCurve.js.

import { ilfLossCost } from '../methods/ilfCurve.js';
import { pickByTerritory } from '../rateSelect.js';
import { num, numOrNull } from '../num.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'LIABILITY_LIMIT';

/** The exposure units a liability class can rate against. */
export const BASIS_UNITS = ['TURNOVER', 'PAYROLL', 'FEE_INCOME', 'UNITS'];

/**
 * Pull this family's exposure out of a section's exposure_detail blob.
 *
 * @param {object|null} section fac_risk_section row
 * @returns {{exposureBase: number|null, basisUnit: string|null, territory: string,
 *            limit: number|null, attachment: number, aggregateLimit: number|null,
 *            claimsMade: boolean, retroYears: number|null,
 *            defenceCostsInAddition: boolean, aggregateReinstatements: number|null,
 *            warnings: string[]}}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  const warnings = [];

  const exposureBase = numOrNull(section?.exposure_base) ?? numOrNull(detail.exposure_base);
  const basisUnit = (detail.basis_unit || section?.exposure_unit || '').toUpperCase() || null;
  if (basisUnit && !BASIS_UNITS.includes(basisUnit)) {
    warnings.push(
      `Exposure unit "${basisUnit}" is not one this family rates on `
      + `(${BASIS_UNITS.join(', ')}).`,
    );
  }

  // Recorded for the slip, not priced: capping the aggregate needs a claim
  // frequency this engine does not hold, and a factor invented for it would
  // be worse than the caveat. Reinstatements, by contrast, ARE priced —
  // each one is another full limit of exposure (F54).
  const aggregateLimit = numOrNull(detail.aggregate_limit);
  if (aggregateLimit !== null) {
    warnings.push(
      'The aggregate limit is recorded for information only — it does not change the price. '
      + 'Pricing an aggregate cap needs a claim-frequency view this engine does not hold; '
      + 'aggregate reinstatements are what the price responds to.',
    );
  }

  return {
    exposureBase,
    basisUnit,
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    limit: numOrNull(section?.limit_amount) ?? numOrNull(detail.limit),
    attachment: num(section?.attachment ?? detail.attachment),
    aggregateLimit,
    claimsMade: Boolean(detail.claims_made),
    retroYears: numOrNull(detail.retro_years),
    defenceCostsInAddition: Boolean(detail.defence_costs_in_addition),
    aggregateReinstatements: numOrNull(detail.aggregate_reinstatements),
    warnings,
  };
}

/**
 * Pick the base rate for a class, territory and unit.
 *
 * Territory matters more here than anywhere else in the module: US-exposed
 * liability behaves nothing like the rest of the world, and a worldwide rate
 * applied to a US-exposed account is the classic way to underprice one.
 * A worldwide fallback is used only when nothing more specific exists, and
 * it is reported.
 *
 * The unit filter is hard, never a fallback. `unitsAvailable` reports what the
 * class *does* have loaded so the caller can say "you asked for payroll and we
 * hold turnover" rather than the useless "nothing is loaded".
 *
 * @param {Array<object>} rates fac_liability_base_rate rows
 * @param {object} args {facCobId, territory, basisUnit}
 * @returns {{rate: object|null, fellBackToWorldwide: boolean, unitsAvailable: string[]}}
 */
export function selectBaseRate(rates, { facCobId, territory, basisUnit }) {
  const forClass = (rates || []).filter(
    (r) => !facCobId || !r.fac_cob_id || r.fac_cob_id === facCobId,
  );
  const unitsAvailable = [...new Set(forClass.map((r) => r.basis_unit).filter(Boolean))];
  const pool = forClass.filter((r) => !basisUnit || r.basis_unit === basisUnit);
  return { ...pickByTerritory(pool, territory), unitsAvailable };
}

/**
 * Pick the ILF curve for a family and territory, same territorial precedence.
 *
 * `familyCode` narrows to the curves a family owns — marine liability rates
 * on these mechanics but on a marine severity curve, and a general-liability
 * curve applied to a P&I limit is not a near-enough answer. Curves with no
 * family_code are general-purpose and always in the pool.
 *
 * @param {Array<object>} curves fac_ilf_curve rows (+ points)
 * @param {object} args {territory, familyCode}
 * @returns {object|null}
 */
export function selectIlfCurve(curves, { territory, familyCode = null }) {
  const pool = (curves || []).filter(
    (c) => !familyCode || !c.family_code || c.family_code === familyCode,
  );
  const owned = familyCode ? pool.filter((c) => c.family_code === familyCode) : [];
  const search = owned.length > 0 ? owned : pool;
  return search.find((c) => (c.territory || '').toUpperCase() === (territory || '').toUpperCase())
    || search.find((c) => !c.territory || (c.territory || '').toUpperCase() === 'WORLDWIDE')
    || search[0]
    || null;
}

/**
 * The family's loss-cost candidates. Burning cost and benchmark are generic
 * and added by the pipeline; this contributes the exposure-side view.
 *
 * @param {object} args
 * @param {object} args.risk
 * @param {object|null} args.section
 * @param {object} args.structure {attachment, limit}
 * @param {object} args.rates {liabilityBaseRates, ilfCurves}
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ risk, section, structure = {}, rates = {}, familyCode = FAMILY_CODE }) {
  const exposure = readExposure(section);
  const { rate, fellBackToWorldwide, unitsAvailable } = selectBaseRate(rates.liabilityBaseRates, {
    facCobId: section?.fac_cob_id || risk?.fac_cob_id,
    territory: exposure.territory,
    basisUnit: exposure.basisUnit,
  });
  const curve = selectIlfCurve(rates.ilfCurves, { territory: exposure.territory, familyCode });

  // A rate quoted against turnover applied to a payroll figure is wrong by
  // an order of magnitude and looks entirely plausible. Refuse rather than
  // guess which one the underwriter meant — and say which units we hold, so
  // the fix is obvious instead of a hunt through the reference tables.
  if (!rate && exposure.basisUnit && unitsAvailable.length > 0
      && !unitsAvailable.includes(exposure.basisUnit)) {
    return [{
      code: 'ILF_CURVE',
      result: {
        available: false,
        unavailableReason: `The section states its exposure in ${exposure.basisUnit} but the `
          + `rates loaded for this class are per ${unitsAvailable.join(' / ')}. Those are not `
          + `interchangeable — load a ${exposure.basisUnit} rate, or restate the exposure.`,
        diagnostics: { section_unit: exposure.basisUnit, rate_units: unitsAvailable },
      },
    }];
  }

  const result = ilfLossCost({
    exposureBase: exposure.exposureBase,
    baseRate: rate,
    curve,
    attachment: numOrNull(structure.attachment) ?? exposure.attachment,
    limit: numOrNull(structure.limit) ?? exposure.limit,
    claimsMade: exposure.claimsMade,
    retroYears: exposure.retroYears,
    defenceCostsInAddition: exposure.defenceCostsInAddition,
    defenceCostsFactor: numOrNull(curve?.params?.defence_costs_factor),
    aggregateReinstatements: exposure.aggregateReinstatements,
  });

  if (result.available) {
    result.diagnostics = {
      ...result.diagnostics,
      territory: exposure.territory,
      territory_fallback: fellBackToWorldwide,
      warnings: [
        ...exposure.warnings,
        ...(fellBackToWorldwide && exposure.territory !== 'WORLDWIDE'
          ? [`No ${exposure.territory} rate loaded — using the worldwide rate. US-exposed `
            + 'liability in particular does not behave like worldwide business.']
          : []),
      ],
    };
  }

  return [{ code: 'ILF_CURVE', result }];
}

/** @type {import('../registry.js').FacFamily} */
export const liabilityLimit = {
  ...metaFor('LIABILITY_LIMIT'),
  readExposure,
  computeCandidates,
  // Casualty has no sum insured. The premium base is the exposure unit the
  // rate was quoted against — turnover, payroll, fee income or units — and
  // using a sum insured here would produce a premium wrong by whatever ratio
  // the two happen to sit in.
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + (numOrNull(s?.exposure_base) ?? numOrNull(s?.exposure_detail?.exposure_base) ?? 0),
    0,
  ),
};

/**
 * Marine Liability — the same mechanics on a marine curve.
 *
 * P&I, charterers' and ship-repairers' liability price to a limit exactly as
 * general liability does; what differs is the severity curve behind the ILFs
 * and the exposure unit (tonnage, berth-nights, contract value rather than
 * turnover). Sharing the engine rather than copying it means a fix to the
 * limit maths reaches both, which is the whole point of the family split.
 *
 * @type {import('../registry.js').FacFamily}
 */
export const marineLiability = {
  ...liabilityLimit,
  code: 'MARINE_LIABILITY',
  label: 'Marine Liability',
  segment: 'MARINE_TRANSIT',
  credibility: { k: 10, maxZ: 0.60, unit: 'CLAIM_COUNT' },
  computeCandidates: (args) => computeCandidates({ ...args, familyCode: 'MARINE_LIABILITY' }),
};

export default liabilityLimit;
