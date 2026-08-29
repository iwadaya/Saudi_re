// shared/fac/methods/ilfCurve.js
//
// Increased limit factors: how a liability loss cost changes with the limit.
//
// Casualty has no sum insured. There is nothing to take a rate per mille of,
// so the loss cost is built the other way round — from a rate against an
// exposure unit (turnover, payroll, fee income, vehicles) at a BASIC LIMIT,
// stepped up to the limit actually being written:
//
//     ILF(L) = expected loss capped at L  ÷  expected loss capped at B
//
// and the cost of an excess layer L xs D is the difference between the two:
//
//     E[layer L xs D] = BasicLimitLossCost × [ ILF(D + L) − ILF(D) ]
//
// This is the single largest gap the redesign found. The whole Casualty
// segment — General and Public Liability, Products, Employers' Liability,
// Professional Indemnity, D&O, plus Financial Lines and marine liability —
// reached the property engine, which asked for an occupancy code and a
// NatCat zone and threw when it did not get them (findings F1 and F2).
//
// ── Two curve forms ───────────────────────────────────────────────────────
//
// POWER (Riebesell, 1936 — also called alpha curves or the German method,
// and the London market's usual choice for non-US liability):
//
//     ILF(L) = (L / B)^α    where    α = log₂(1 + r)
//
// r is the "doubling loading": the fixed percentage by which the risk
// premium rises each time the limit doubles, whatever the limit. A 20%
// doubling loading gives α = log₂(1.2) ≈ 0.263.
//
// TABULATED, for the classes where a published table beats a smooth curve —
// US-exposed liability in particular, where the tail does not obey a single
// exponent.
//
// ── What is NOT here ──────────────────────────────────────────────────────
// No curve parameters. α, the doubling loading and every tabulated point are
// a view about severity backed by data somebody owns, so they are loaded as
// reference data (fac_ilf_curve, migration 136) and this module only applies
// them. Same discipline as the property exposure curves — see
// docs/facultative-pricing-design.md §8.
//
// Reference: Riebesell, P. (1936). See also Mata, A., "Casualty Excess
// Pricing Using Power Curves", CARe 2009; and Venter & Pagliaccio,
// "Distributions Underlying Power Function ILFs (Riebesell Revisited)", 2005.

import { num, numOrNull } from '../num.js';

export const METHOD_CODE = 'ILF_CURVE';

/**
 * Riebesell's doubling loading expressed as the curve exponent.
 *
 * @param {number} doublingLoading  e.g. 0.20 for "+20% each time the limit doubles"
 * @returns {number} α
 */
export function alphaFromDoublingLoading(doublingLoading) {
  const r = num(doublingLoading);
  if (r <= -1) throw new Error(`Doubling loading must exceed −100%; got ${doublingLoading}`);
  return Math.log2(1 + r);
}

/** The inverse, for showing a curve's α back to an underwriter in their terms. */
export function doublingLoadingFromAlpha(alpha) {
  return 2 ** num(alpha) - 1;
}

/**
 * Build an ILF evaluator from a curve reference-data row.
 *
 * Returns a function of the limit, normalised so ILF(basic_limit) = 1.
 *
 * @param {{kind?: string, basic_limit: number|string, params?: object, points?: Array}} curve
 * @returns {(limit: number) => number}
 */
export function ilfEvaluator(curve) {
  if (!curve) throw new Error('No ILF curve supplied.');
  const basic = num(curve.basic_limit);
  if (!(basic > 0)) throw new Error('An ILF curve needs a positive basic limit.');

  if (curve.kind === 'TABULATED') {
    const pts = (curve.points || [])
      .map((p) => ({ limit: num(p.limit_amount ?? p.limit), ilf: num(p.ilf) }))
      .filter((p) => p.limit > 0 && p.ilf > 0)
      .sort((a, b) => a.limit - b.limit);
    if (pts.length < 2) throw new Error('A tabulated ILF curve needs at least two points.');
    const evaluate = (L) => {
      if (L <= pts[0].limit) return pts[0].ilf * (L / pts[0].limit);
      const last = pts[pts.length - 1];
      if (L >= last.limit) return last.ilf;
      let lo = 0;
      let hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].limit <= L) lo = mid; else hi = mid;
      }
      const a = pts[lo];
      const b = pts[hi];
      return a.ilf + ((L - a.limit) / (b.limit - a.limit)) * (b.ilf - a.ilf);
    };
    // The contract says the table is normalised so ILF(basic_limit) = 1.
    // A table that interpolates to anything else at its own basic limit is
    // mis-normalised reference data, and applying it would scale every
    // price by the error — refuse it at the door (F43).
    const atBasic = evaluate(basic);
    if (!(Math.abs(atBasic - 1) <= 1e-3)) {
      throw new Error(
        `Tabulated ILF curve is not normalised at its basic limit: ILF(${basic}) `
        + `interpolates to ${atBasic.toFixed(6)}, not 1. Fix the curve's points or its basic_limit.`,
      );
    }
    return (limit) => {
      const L = num(limit);
      if (L <= 0) return 0;
      // Below the lowest tabulated point, proportionality — the only
      // defensible reading without a point to interpolate to. Above the
      // table, hold flat: extrapolating a severity tail past the data is
      // exactly the guess this module refuses to make elsewhere.
      return evaluate(L);
    };
  }

  // POWER (Riebesell).
  const explicitAlpha = numOrNull(curve.params?.alpha);
  const alpha = explicitAlpha ?? alphaFromDoublingLoading(
    numOrNull(curve.params?.doubling_loading) ?? 0,
  );
  if (!(alpha > 0)) {
    throw new Error('A power ILF curve needs a positive alpha or doubling loading.');
  }
  return (limit) => {
    const L = num(limit);
    if (L <= 0) return 0;
    return (L / basic) ** alpha;
  };
}

/**
 * Expected loss to a limit band, given the basic-limit loss cost.
 *
 *   E[L xs D] = BasicLimitLossCost × [ ILF(D + L) − ILF(D) ]
 *
 * A primary policy is the D = 0 case, where ILF(0) = 0 and the whole thing
 * collapses to BasicLimitLossCost × ILF(L) — the ordinary increased-limits
 * calculation.
 *
 * @param {object} args
 * @param {number} args.basicLimitLossCost
 * @param {number} args.attachment
 * @param {number} args.limit             Infinity is not meaningful here — a
 *                                        liability layer always has a limit
 * @param {(limit: number) => number} args.ILF
 * @returns {number}
 */
export function ilfLayerLossCost({ basicLimitLossCost, attachment, limit, ILF }) {
  const base = num(basicLimitLossCost);
  if (base <= 0) return 0;
  const d = Math.max(num(attachment), 0);
  const l = num(limit);
  if (!(l > 0)) return 0;
  const top = ILF(d + l);
  const bottom = d > 0 ? ILF(d) : 0;
  return base * Math.max(top - bottom, 0);
}

/**
 * Claims-made step factor.
 *
 * A claims-made policy in its first year covers only claims made in that
 * year from a retroactive date of inception, so it is exposed to a fraction
 * of a mature occurrence policy's loss cost. The exposure builds as the
 * retroactive period lengthens, and the usual market treatment is a table of
 * step factors by retro year reaching 1.0 at maturity.
 *
 * The steps themselves are class-specific, so they come from the curve's
 * params. Absent, the factor is 1.0 — a claims-made policy is never priced
 * UP by an assumption this module invented.
 *
 * @param {object} args
 * @param {boolean} args.claimsMade
 * @param {number|null} args.retroYears
 * @param {number[]|null} args.steps  e.g. [0.4, 0.7, 0.85, 0.95, 1.0]
 * @returns {{factor: number, basis: string}}
 */
export function claimsMadeStepFactor({ claimsMade, retroYears, steps }) {
  if (!claimsMade) return { factor: 1, basis: 'OCCURRENCE' };
  const table = Array.isArray(steps) ? steps.map(num).filter((n) => n > 0) : [];
  if (table.length === 0) {
    return { factor: 1, basis: 'CLAIMS_MADE_NO_STEPS' };
  }
  const years = Math.max(Math.trunc(num(retroYears)), 0);
  // Year 1 of cover is index 0; a retro period longer than the table is mature.
  const idx = Math.min(years, table.length - 1);
  return { factor: table[idx], basis: `CLAIMS_MADE_YEAR_${years + 1}` };
}

/**
 * The ILF_CURVE loss-cost candidate.
 *
 * @param {object} args
 * @param {number} args.exposureBase        turnover / payroll / fee income / units
 * @param {object|null} args.baseRate       fac_liability_base_rate row
 * @param {object|null} args.curve          fac_ilf_curve row (+ points)
 * @param {number} args.attachment
 * @param {number} args.limit
 * @param {boolean} [args.claimsMade]
 * @param {number} [args.retroYears]
 * @param {boolean} [args.defenceCostsInAddition]
 * @param {number} [args.defenceCostsFactor] applied when costs are in addition
 * @param {number} [args.aggregateReinstatements]
 * @returns {{available: boolean, unavailableReason?: string, lossCost?: number,
 *            ratePm?: number, diagnostics: object}}
 */
export function ilfLossCost({
  exposureBase, baseRate, curve, attachment = 0, limit,
  claimsMade = false, retroYears = null,
  defenceCostsInAddition = false, defenceCostsFactor = null,
  aggregateReinstatements = null,
}) {
  const exposure = num(exposureBase);
  if (!(exposure > 0)) {
    return {
      available: false,
      unavailableReason: 'No exposure base. Casualty rates against turnover, payroll or fee '
        + 'income — enter it on the section before pricing.',
      diagnostics: {},
    };
  }
  if (!baseRate) {
    return {
      available: false,
      unavailableReason: 'No liability base rate is loaded for this class and territory. '
        + 'Load a rate table before pricing.',
      diagnostics: { exposure_base: exposure },
    };
  }
  if (!curve) {
    return {
      available: false,
      unavailableReason: 'No ILF curve is loaded for this class and territory. Casualty prices '
        + 'to a limit — without a curve there is no way to step the basic-limit cost to it.',
      diagnostics: { exposure_base: exposure },
    };
  }
  if (!(num(limit) > 0)) {
    return {
      available: false,
      unavailableReason: 'No policy limit. A liability loss cost is defined by its limit — set '
        + 'one on the section or the layer.',
      diagnostics: { exposure_base: exposure },
    };
  }

  // The formula is only valid when the rate and the curve agree on the basic
  // limit: the rate quotes the loss cost AT baseRate.basic_limit, and the
  // curve is normalised to 1 AT curve.basic_limit. The two are loaded from
  // separate tables and selected independently, so a mismatch is reachable —
  // and stepping a 1m-basic cost through a 5m-normalised curve silently
  // mis-prices by the ratio of the two. Refuse, the same way a basis-unit
  // mismatch is refused, rather than guess which limit the carrier meant
  // (F43/F52).
  const rateBasic = numOrNull(baseRate.basic_limit);
  const curveBasic = numOrNull(curve.basic_limit);
  if (rateBasic !== null && curveBasic !== null && rateBasic !== curveBasic) {
    return {
      available: false,
      unavailableReason: `The base rate is quoted at a basic limit of ${rateBasic.toLocaleString('en-US')} `
        + `but the ILF curve${curve.curve_code ? ` (${curve.curve_code})` : ''} is normalised at `
        + `${curveBasic.toLocaleString('en-US')}. Those are not interchangeable — stepping one from the `
        + 'other mis-prices by the ratio of the two. Load a curve and a rate that share a basic limit.',
      diagnostics: {
        exposure_base: exposure,
        basic_limit: rateBasic,
        curve_basic_limit: curveBasic,
        curve: curve.curve_code || null,
      },
    };
  }

  const divisor = num(baseRate.basis_divisor) || 1;
  const basicLimitLossCost = (exposure / divisor) * num(baseRate.loss_cost_per_unit);

  const ILF = ilfEvaluator(curve);
  let lossCost = ilfLayerLossCost({ basicLimitLossCost, attachment, limit, ILF });

  const step = claimsMadeStepFactor({ claimsMade, retroYears, steps: curve.params?.claims_made_steps });
  lossCost *= step.factor;

  // Defence costs in addition to the limit are a genuine extra exposure.
  // The factor is a carrier parameter; absent, costs are treated as inside
  // the limit, which is the assumption that does not inflate the price.
  const dcFactor = defenceCostsInAddition ? (numOrNull(defenceCostsFactor) ?? 1) : 1;
  lossCost *= dcFactor;

  // Each reinstated aggregate is another full limit of exposure.
  const reinstated = Math.max(num(aggregateReinstatements), 0);
  const aggFactor = 1 + reinstated;
  lossCost *= aggFactor;

  return {
    available: true,
    lossCost,
    // Liability has no sum insured, so the "rate" that means anything is the
    // rate on the exposure base, expressed per mille of it.
    ratePm: exposure > 0 ? (lossCost / exposure) * 1000 : null,
    diagnostics: {
      exposure_base: exposure,
      basis_unit: baseRate.basis_unit,
      basis_divisor: divisor,
      basic_limit: num(baseRate.basic_limit),
      basic_limit_loss_cost: basicLimitLossCost,
      curve: curve.curve_code || null,
      curve_kind: curve.kind || 'POWER',
      alpha: curve.kind === 'TABULATED' ? null
        : (numOrNull(curve.params?.alpha)
          ?? alphaFromDoublingLoading(numOrNull(curve.params?.doubling_loading) ?? 0)),
      ilf_at_attachment: attachment > 0 ? ILF(num(attachment)) : 0,
      ilf_at_top: ILF(num(attachment) + num(limit)),
      attachment: num(attachment),
      limit: num(limit),
      claims_made_factor: step.factor,
      claims_made_basis: step.basis,
      defence_costs_factor: dcFactor,
      aggregate_factor: aggFactor,
    },
  };
}
