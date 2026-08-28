// shared/fac/period.js
//
// Project periods and how a project premium earns.
//
// Every other family in this module rates an annual policy. Construction does
// not: a CAR policy is written once, for the whole project period, and the
// premium is 100% payable at inception. Two consequences the rest of the
// module has to be told about.
//
// **The rate covers the period, not a year.** A 36-month project is not three
// annual policies — the exposure is not flat, and the rate is not tripled. The
// market convention is a base rate for a baseline period (usually twelve
// months) with a per-month loading beyond it. That loading is a carrier
// parameter, so it is loaded from `fac_project_base_rate`, never assumed here.
//
// **The premium earns over the period, and not evenly.** Values on a
// construction site rise slowly through mobilisation and groundworks, fast
// through erection, and level off through testing — an S-curve, not a
// straight line. A portfolio view that earns a 36-month CAR premium
// straight-line overstates earned premium in year one and understates the
// unearned reserve. Which pattern applies is a decision that gets recorded on
// the risk; both are implemented, neither is guessed.

import { num, numOrNull } from './num.js';

export const EARNING_PATTERNS = ['STRAIGHT_LINE', 'S_CURVE'];

/**
 * The period factor for a project longer (or shorter) than the baseline.
 *
 *     factor = 1 + perMonth × (months − baseline)
 *
 * A project shorter than the baseline earns the discount symmetrically, which
 * is what a per-month loading means; the factor is floored at a small positive
 * number so a very short project cannot produce a zero or negative rate.
 *
 * @param {object} args
 * @param {number} args.months
 * @param {number|null} args.perMonth        from fac_project_base_rate
 * @param {number} [args.baselineMonths]
 * @returns {{factor: number, basis: string, applied: boolean}}
 */
export function projectPeriodFactor({ months, perMonth, baselineMonths = 12 }) {
  const m = num(months);
  const rate = numOrNull(perMonth);
  const baseline = num(baselineMonths) || 12;
  if (!(m > 0)) {
    return { factor: 1, basis: 'NO_PERIOD', applied: false };
  }
  if (rate === null) {
    return { factor: 1, basis: 'NO_PERIOD_LOADING_LOADED', applied: false };
  }
  const factor = Math.max(1 + rate * (m - baseline), 0.05);
  return {
    factor,
    basis: `${m}m vs ${baseline}m baseline at ${(rate * 100).toFixed(2)}%/month`,
    applied: true,
  };
}

/**
 * The fraction of a project premium earned by a point in the period.
 *
 * STRAIGHT_LINE is t.
 *
 * S_CURVE is the smoothstep 3t² − 2t³: zero at inception, one at expiry,
 * flat gradient at both ends, symmetric about the midpoint. It is chosen for
 * being the simplest closed form with those properties — it is a shape, not
 * a fitted model of any particular project, and it is applied only where the
 * risk says to apply it.
 *
 * @param {number} elapsedFraction  0 → inception, 1 → expiry
 * @param {string} [pattern]
 * @returns {number}
 */
export function earnedFraction(elapsedFraction, pattern = 'STRAIGHT_LINE') {
  const t = Math.min(Math.max(num(elapsedFraction), 0), 1);
  if (pattern === 'S_CURVE') return t * t * (3 - 2 * t);
  return t;
}

/**
 * How far through its period a risk is at a given date.
 *
 * @param {object} args
 * @param {string|Date|null} args.from
 * @param {string|Date|null} args.to
 * @param {string|Date|null} args.asOf
 * @returns {number|null} null when the dates cannot place it
 */
export function elapsedFraction({ from, to, asOf }) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  const at = asOf ? new Date(asOf) : null;
  if (!start || !end || !at) return null;
  if ([start, end, at].some((d) => Number.isNaN(d.getTime()))) return null;
  const span = end.getTime() - start.getTime();
  if (!(span > 0)) return null;
  return Math.min(Math.max((at.getTime() - start.getTime()) / span, 0), 1);
}

/**
 * Earned and unearned premium at a date.
 *
 * @param {object} args
 * @param {number} args.premium
 * @param {string|Date|null} args.from
 * @param {string|Date|null} args.to
 * @param {string|Date|null} args.asOf
 * @param {string} [args.pattern]
 * @returns {{earned: number|null, unearned: number|null, fraction: number|null, pattern: string}}
 */
export function earnedPremium({ premium, from, to, asOf, pattern = 'STRAIGHT_LINE' }) {
  const p = num(premium);
  const elapsed = elapsedFraction({ from, to, asOf });
  if (elapsed === null) {
    return { earned: null, unearned: null, fraction: null, pattern };
  }
  const fraction = earnedFraction(elapsed, pattern);
  return { earned: p * fraction, unearned: p * (1 - fraction), fraction, pattern };
}

/**
 * The project period in months, from the dates if they are set and from
 * `policy_period_months` otherwise.
 *
 * Two conventions matter here (F49, F97):
 *
 *   • The expiry date on a slip is usually the LAST COVERED DAY, so the pair
 *     is measured as [inception, expiry + 1 day) and then truncated. An
 *     annual policy written 2026-01-01 to 2026-12-31 is 12 months, not 11 —
 *     and one already stated exclusively (to 2027-01-01) still reads 12,
 *     because the extra day truncates away. A leap-day anniversary
 *     (2024-02-29 to 2025-02-28) rolls to 1 March and reads 12 as well.
 *
 *   • ISO date strings parse as UTC midnight, so they are read back with the
 *     UTC getters. Local getters made the answer depend on the server's
 *     timezone — off by a month for month-boundary dates west of UTC.
 *
 * @param {object} risk fac_risk row
 * @returns {number|null}
 */
export function periodMonths(risk) {
  const stated = numOrNull(risk?.policy_period_months);
  const from = risk?.inception_date ? new Date(risk.inception_date) : null;
  const to = risk?.expiry_date ? new Date(risk.expiry_date) : null;
  if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from) {
    // Expiry is the last covered day: the exclusive end is one day later.
    // Adding 24h is exact in UTC — there is no DST there.
    const end = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    const months = (end.getUTCFullYear() - from.getUTCFullYear()) * 12
      + (end.getUTCMonth() - from.getUTCMonth())
      + (end.getUTCDate() >= from.getUTCDate() ? 0 : -1);
    if (months > 0) return months;
  }
  return stated;
}
