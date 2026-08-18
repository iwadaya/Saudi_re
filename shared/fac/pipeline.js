// shared/fac/pipeline.js
//
// The technical build-up: several independent estimates of the same loss
// cost, blended by credibility, then loaded and grossed up once.
//
//   loss-cost candidates
//     → credibility blend
//     → + cat load
//     → + risk load        θ × σ where the experience supports it
//     → + internal expense
//     → ÷ (1 − commission − brokerage − tax − margin)
//     = technical gross rate
//
// Two properties of this arrangement are worth stating, because they are
// what make it safe to put in front of the existing property engine:
//
//   • With the family's own workbook rate as the only candidate and no
//     loads configured, the technical gross rate is exactly what the
//     engine produced before this module existed. Phase 2 changes no
//     number on a risk with no loss history and no curve. There is a test
//     that says so.
//
//   • The gross-up happens once, here. The family engine hands over a NET
//     rate; nothing upstream may divide by the expense denominator, or the
//     commission gets counted twice.

import {
  mechanicalWeights, applyWeightOverride, blendRates, annualLossVolatility,
  DEFAULT_CREDIBILITY,
} from './credibility.js';
import { num, numOrNull } from './num.js';

/**
 * What each method is for. The blend needs to know which side of the
 * credibility weighting a candidate sits on; REFERENCE methods are shown
 * and never weighted.
 */
export const METHOD_ROLE = {
  WORKBOOK_RATE:  'EXPOSURE',
  EXPOSURE_CURVE: 'EXPOSURE',
  ILF_CURVE:      'EXPOSURE',
  BURNING_COST:   'EXPERIENCE',
  FREQ_SEVERITY:  'EXPERIENCE',
  BENCHMARK:      'REFERENCE',
  CAT_MODEL:      'ADDITIVE',
  MANUAL:         'EXPOSURE',
};

export const METHOD_LABEL = {
  WORKBOOK_RATE:  'Workbook rate',
  EXPOSURE_CURVE: 'Exposure curve',
  ILF_CURVE:      'Increased limit factors',
  BURNING_COST:   'Burning cost',
  FREQ_SEVERITY:  'Frequency × severity',
  BENCHMARK:      'Benchmark',
  CAT_MODEL:      'Cat model',
  MANUAL:         'Manual',
};

/** Multiple of σ used for the risk load when the experience supports one. */
export const DEFAULT_RISK_LOAD_THETA = 0.10;

/**
 * Normalise a method result into a candidate the blend can reason about.
 *
 * @param {string} code
 * @param {object} result  a *LossCost() return value
 * @returns {object}
 */
export function toCandidate(code, result) {
  const role = METHOD_ROLE[code] || 'EXPOSURE';
  if (!result || result.available === false) {
    return {
      code, role, label: METHOD_LABEL[code] || code,
      available: false,
      unavailableReason: result?.unavailableReason || 'Not available.',
      ratePm: null,
      diagnostics: result?.diagnostics || {},
    };
  }
  return {
    code, role, label: METHOD_LABEL[code] || code,
    available: true,
    ratePm: numOrNull(result.ratePm),
    lossCost: result.lossCost ?? null,
    claimCount: result.claimCount ?? null,
    years: result.years ?? null,
    diagnostics: result.diagnostics || {},
  };
}

/**
 * Blend the candidates and build the technical premium.
 *
 * @param {object} args
 * @param {Array<object>} args.candidates      from toCandidate()
 * @param {object} [args.credibility]          {k, maxZ} for this family
 * @param {object} [args.weightOverride]       {weights, reasonCode}
 * @param {number} [args.catLoadPm]            added after the blend, never inside it
 * @param {number} [args.riskLoadTheta]        multiple of σ
 * @param {number} [args.riskLoadPct]          fallback when σ is not measurable
 * @param {number} [args.internalExpensePct]   fraction of the expected loss
 * @param {number} [args.commissionPct]
 * @param {number} [args.brokeragePct]
 * @param {number} [args.taxPct]
 * @param {number} [args.marginPct]
 * @param {number} [args.exposureTotal]        sum insured, to turn ‰ into money
 * @returns {object} the whole build-up, line by line
 */
export function buildTechnicalPremium({
  candidates,
  credibility = DEFAULT_CREDIBILITY,
  weightOverride = null,
  catLoadPm = 0,
  riskLoadTheta = DEFAULT_RISK_LOAD_THETA,
  riskLoadPct = 0,
  internalExpensePct = 0,
  commissionPct = 0,
  brokeragePct = 0,
  taxPct = 0,
  marginPct = 0,
  exposureTotal = 0,
}) {
  const warnings = [];
  const list = candidates || [];

  // ── Blend ────────────────────────────────────────────────────────
  const experience = list.find((c) => c.role === 'EXPERIENCE' && c.available);
  const volume = num(experience?.claimCount);
  const mech = mechanicalWeights(list, credibility, volume);
  const applied = applyWeightOverride(mech.weights, weightOverride);
  if (applied.error) warnings.push(applied.error);

  const blendedLossCostPm = blendRates(list, applied.weights);
  if (blendedLossCostPm == null) {
    return {
      priced: false,
      reason: 'No loss-cost method produced a rate.',
      candidates: list,
      weights: applied.weights,
      warnings,
    };
  }

  // ── Loads ────────────────────────────────────────────────────────
  const expectedLossPm = blendedLossCostPm + num(catLoadPm);

  // Risk load. Where the experience gives at least three years of annual
  // layer loss we load on the dispersion those years actually show;
  // otherwise a flat percentage, flagged as the weaker basis it is.
  let riskLoadPm;
  let riskLoadBasis;
  const series = experience?.diagnostics?.annual_layer_losses;
  const vol = annualLossVolatility(series);
  const avgExposure = num(experience?.diagnostics?.average_exposure);
  if (vol && vol.sigma > 0 && avgExposure > 0) {
    riskLoadPm = (num(riskLoadTheta) * vol.sigma / avgExposure) * 1000;
    riskLoadBasis = { kind: 'THETA_SIGMA', theta: num(riskLoadTheta), sigma: vol.sigma, years: vol.years };
  } else {
    riskLoadPm = expectedLossPm * num(riskLoadPct);
    riskLoadBasis = { kind: 'PERCENTAGE', pct: num(riskLoadPct) };
    if (num(riskLoadPct) > 0) {
      warnings.push(
        'Risk load is a flat percentage — fewer than three years of loss experience, so the '
        + 'dispersion the load should reflect cannot be measured.',
      );
    }
  }

  const internalExpensePm = expectedLossPm * num(internalExpensePct);
  const technicalNetPm = expectedLossPm + riskLoadPm + internalExpensePm;

  // ── Gross-up, once ───────────────────────────────────────────────
  const comm = num(commissionPct);
  const brok = num(brokeragePct);
  const tax = num(taxPct);
  const margin = num(marginPct);
  const denom = 1 - comm - brok - tax - margin;
  let technicalGrossPm;
  if (denom <= 0) {
    warnings.push(
      `Commission + brokerage + tax + margin ≥ 100% (denominator ${denom.toFixed(4)}); `
      + 'using the technical net rate as the gross rate.',
    );
    technicalGrossPm = technicalNetPm;
  } else {
    technicalGrossPm = technicalNetPm / denom;
  }

  const si = num(exposureTotal);
  const premium = (pm) => (si > 0 && pm != null ? (pm * si) / 1000 : null);

  return {
    priced: true,
    candidates: list,
    weights: applied.weights,
    weightSource: applied.source,
    weightOverrideReason: applied.reasonCode || null,
    credibility: { z: mech.z, ...mech.detail },
    blendedLossCostPm,
    catLoadPm: num(catLoadPm),
    expectedLossPm,
    riskLoadPm,
    riskLoadBasis,
    internalExpensePm,
    technicalNetPm,
    grossUpDenominator: denom,
    technicalGrossPm,
    premiums: {
      expectedLoss: premium(expectedLossPm),
      technicalNet: premium(technicalNetPm),
      technicalGross: premium(technicalGrossPm),
    },
    warnings,
  };
}

/**
 * How the quoted rate compares with the technical one — the number a
 * portfolio is ultimately judged on.
 *
 * @param {number|null} quotedPm
 * @param {number|null} technicalGrossPm
 * @returns {number|null}
 */
export function technicalAdequacy(quotedPm, technicalGrossPm) {
  const q = numOrNull(quotedPm);
  const t = numOrNull(technicalGrossPm);
  if (q === null || t === null || t <= 0) return null;
  return q / t;
}
