// shared/pricingMath.js
// Pure math primitives that both the client's pricing engine and the
// server's would-be validation layer depend on. Lives here (not in
// client/src/utils or server/src/lib) because the alternative was
// "duplicate the formula and hope nobody edits one without the other".
//
// Keep strictly pure + dependency-free — no imports, no Node APIs, no
// React. Either side should be able to import this with a relative
// path and have it work unmodified.
//
// To consume:
//   client:  import { layerHit } from '../../../shared/pricingMath.js';
//   server:  import { layerHit } from '../../../shared/pricingMath.js';
//
// To add a new formula, put it here and cover it with a test. If the
// function needs anything from the app (config, DB, API), it doesn't
// belong here.

/**
 * Layer loss contribution from a single ground-up loss.
 *
 *   layerHit = max(0, min(loss − D, L))
 *
 * @param {number} loss        Ground-up loss amount (inflation-adjusted).
 * @param {number} deductible  Layer attachment point (D).
 * @param {number} limit       Layer width (L).
 * @returns {number} Amount of the loss that falls in this layer.
 */
export function layerHit(loss, deductible, limit) {
  if (!Number.isFinite(loss) || !Number.isFinite(deductible) || !Number.isFinite(limit)) return 0;
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(loss - deductible, limit));
}

/**
 * Weighted average of parallel arrays `values` and `weights`. Returns
 * null when total weight is 0 so callers can distinguish "no data"
 * from a legitimate zero average.
 *
 * @param {number[]} values
 * @param {number[]} weights
 * @returns {number|null}
 */
export function weightedAverage(values, weights) {
  if (!Array.isArray(values) || !Array.isArray(weights)) return null;
  if (values.length !== weights.length || values.length === 0) return null;
  let sum = 0, totalW = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    const w = Number(weights[i]);
    if (!Number.isFinite(v) || !Number.isFinite(w)) continue;
    if (w <= 0) continue;
    sum += v * w;
    totalW += w;
  }
  return totalW > 0 ? sum / totalW : null;
}

/**
 * Convert a total loss observed over N years to an annual expected
 * loss.
 *
 * IMPORTANT — what `years` must be:
 *   `years` is the **total elapsed observation window**, including
 *   every zero-loss year. Reinsurance pricing relies on the caller
 *   passing the full historical window (e.g. 10 if you have 10 years
 *   of experience, regardless of how many had losses), not just the
 *   count of years that had at least one loss above the threshold.
 *
 *   Wrong: years = nYearsWithLosses → over-states expected annual
 *           loss by a factor of (totalYears / nYearsWithLosses).
 *
 *   Right: years = totalYearsObserved (zero-loss years included).
 *
 * @warning Passing only the active years is the most common
 *   miscalibration in burning-cost pricing. The `years` parameter
 *   must reflect the denominator of the long-run frequency.
 *
 * @param {number} totalLoss   sum of layer losses across all observed years
 * @param {number} years       TOTAL observation window in years
 *                             (active + zero-loss); must be > 0
 * @returns {number} annual expected loss; 0 for invalid input
 */
export function annualiseLoss(totalLoss, years) {
  if (!Number.isFinite(totalLoss) || !Number.isFinite(years) || years <= 0) return 0;
  return totalLoss / years;
}

/**
 * Rate-on-Line: annual expected layer loss expressed as a fraction of
 * the layer limit. A 3% ROL on a $10M limit implies $300k expected
 * annual cost.
 *
 * @param {number} annualLoss Expected annual layer loss.
 * @param {number} limit      Layer width.
 * @returns {number} ROL as a decimal (0.03 = 3%). 0 when limit ≤ 0.
 */
export function rolFromAnnualLoss(annualLoss, limit) {
  if (!Number.isFinite(annualLoss) || !Number.isFinite(limit) || limit <= 0) return 0;
  return annualLoss / limit;
}

/**
 * Inverse of rolFromAnnualLoss: given a ROL and a limit, what premium
 * does the layer earn?
 *
 * @param {number} rol   Rate-on-Line as a decimal (e.g. 0.05).
 * @param {number} limit Layer width.
 * @returns {number}
 */
export function premiumFromRol(rol, limit) {
  if (!Number.isFinite(rol) || !Number.isFinite(limit)) return 0;
  return rol * limit;
}

/**
 * Clamp a number into [min, max]. NaN in, NaN preserved.
 *
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(n, min, max) {
  if (!Number.isFinite(n)) return n;
  return Math.min(Math.max(n, min), max);
}


/**
 * Apply a pricing loading ("target loss ratio" multiplier). A 20%
 * loading turns a 5% pure-loss ROL into a 6.25% gross ROL:
 *   gross = pure / (1 - loading)
 *
 * Negative loadings are clamped to 0 (no loading). Loadings of 100% or
 * more imply division by zero or a negative denominator — that's not a
 * legal pricing input and used to silently return 0, which made the
 * bug invisible to the underwriter. We now throw a RangeError so the
 * upstream code surfaces the bad input instead of paying out a $0
 * loaded rate.
 *
 * @param {number} pureRate
 * @param {number} loadingPct  0..99 (exclusive of 100). Negative values clamped to 0.
 * @returns {number}
 * @throws {RangeError} when loadingPct >= 100 — the rate division
 *   becomes undefined or negative; callers must bound the input first.
 */
export function applyLoading(pureRate, loadingPct) {
  if (!Number.isFinite(pureRate)) return 0;
  const raw = Number(loadingPct);
  const l = Number.isFinite(raw) ? raw : 0;
  if (l >= 100) {
    throw new RangeError(`Loading must be < 100% (got ${l}%)`);
  }
  const clamped = Math.max(0, l);
  return pureRate / (1 - clamped / 100);
}

/**
 * Derive the total_price for one NP pricing component (Risk or Cat).
 * This is the canonical formula the client uses in final_pricing —
 * lifted up here so the server can spot-check client-submitted
 * outputs without duplicating the math.
 *
 * Three-way blend (as of #4 — Pareto separated from burn):
 *   blended = (wB·pureBurn + wP·pareto + wE·exposure) / (wB + wP + wE)
 *   total   = blended / (1 - loading/100)
 *
 * Weights need not sum to 100; the formula divides by Σ weights, so
 * any consistent ratio works. If all three weights are zero the
 * result is 0 (no method selected).
 *
 * @param {number} pureBurn       Pure burning cost rate.
 * @param {number} pareto         Pareto pricing rate.
 * @param {number} exposure       Exposure rating rate.
 * @param {number} weightBurn     % weight on pure burn (0..100).
 * @param {number} weightPareto   % weight on Pareto (0..100).
 * @param {number} weightExposure % weight on exposure (0..100).
 * @param {number} loading        % internal loading (0..99).
 * @returns {number} Blended, loaded rate. 0 when Σ weights ≤ 0 or loading ≥ 100.
 */
export function deriveComponentTotal(pureBurn, pareto, exposure, weightBurn, weightPareto, weightExposure, loading) {
  // Strip non-numeric chars before parseFloat so that values like
  // "10.00%" or "1,250" — which the client stores as formatted strings —
  // parse to 10 / 1250 instead of NaN. Number(v) without stripping
  // returns NaN for any string with a % or comma, silently zeroing
  // every input and making Total ROL always read 0%.
  const toN = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const wB = clamp(toN(weightBurn), 0, 100);
  const wP = clamp(toN(weightPareto), 0, 100);
  const wE = clamp(toN(weightExposure), 0, 100);
  const wTot = wB + wP + wE;
  if (wTot <= 0) return 0;
  const blended = (wB * toN(pureBurn) + wP * toN(pareto) + wE * toN(exposure)) / wTot;
  const loadingN = clamp(toN(loading), 0, 99);
  return loadingN < 100 ? blended / (1 - loadingN / 100) : 0;
}
