// @ts-check
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
 * Canonical loose-number parser for pricing inputs. The client stores many
 * numeric fields as formatted strings ("10.00%", "1,250", "$2,000"); a bare
 * Number("10.00%") is NaN, which would silently zero the input. Stripping
 * everything except digits / dot / minus before parseFloat recovers the value
 * (10 / 1250 / 2000). Exported so BOTH the client/shared formula path and the
 * server-side pricing verifier parse identically — otherwise the verifier
 * re-derives a different "expected" total and flags phantom drift (or misses
 * real drift) on any formatted field. See docs/actuarial-audit.md.
 *
 * @param {unknown} v
 * @returns {number} parsed value, or 0 when not finite
 */
export function parseLooseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
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
 * @param {number} loading        % internal loading (0..99; values >= 100 are
 *   clamped to 99, not thrown — see the note below).
 * @returns {number} Blended, loaded rate. 0 when Σ weights ≤ 0.
 *
 * Loading is CLAMPED to [0,99] here (a >= 100 loading becomes 99 → a huge but
 * finite number), deliberately NOT thrown: this is the canonical formula the
 * LIVE client pricing reducers run on every keystroke of user-entered fields
 * (see final_pricing/state/pricingReducer.ts), so it must degrade gracefully
 * rather than throw and crash the screen. The server-side `applyLoading`
 * (persistence path) throws on the same >= 100 input to surface it before a bad
 * rate is stored. Across the valid 0..99 range the two are identical, and the
 * pricing verifier re-derives with THIS function, so verifier and client always
 * agree. See docs/actuarial-audit.md.
 */
export function deriveComponentTotal(pureBurn, pareto, exposure, weightBurn, weightPareto, weightExposure, loading) {
  // Parse loose/formatted strings consistently with the server verifier — see
  // parseLooseNumber. Number(v) without stripping returns NaN for any value
  // with a % or comma, silently zeroing every input and making Total ROL read 0%.
  const toN = parseLooseNumber;
  const wB = clamp(toN(weightBurn), 0, 100);
  const wP = clamp(toN(weightPareto), 0, 100);
  const wE = clamp(toN(weightExposure), 0, 100);
  const wTot = wB + wP + wE;
  if (wTot <= 0) return 0;
  const blended = (wB * toN(pureBurn) + wP * toN(pareto) + wE * toN(exposure)) / wTot;
  const L = clamp(toN(loading), 0, 99);
  return blended / (1 - L / 100);
}

// ────────────────────────────────────────────────────────────────────────────
// Stop-Loss / Aggregate-XL primitives.
//
// Stop Loss and Aggregate XL are both layer covers attached to the
// AGGREGATE annual loss S = X_1 + … + X_N, not to individual claims.
// The difference is only the basis of the attachment point:
//   - Stop Loss      → attaches at a loss ratio of premium (e.g. 80% LR)
//   - Aggregate XL   → attaches at an absolute aggregate amount
// Same math; one helper converts the loss-ratio form to absolute, and
// from there every formula below is unit-agnostic.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a loss-ratio attachment ("attaches at 80% LR") into an
 * absolute attachment amount given EPI. Used by Stop Loss covers,
 * which quote their priority and width as percentages of premium.
 *
 * @param {number} lossRatioPct  Attachment loss ratio in % (e.g. 80 for 80%).
 * @param {number} epi           Estimated Premium Income (subject premium).
 * @returns {number} Absolute attachment in currency units; 0 for invalid input.
 */
export function attachmentFromLossRatio(lossRatioPct, epi) {
  if (!Number.isFinite(lossRatioPct) || !Number.isFinite(epi) || epi <= 0) return 0;
  return Math.max(0, lossRatioPct / 100) * epi;
}

/**
 * Abramowitz & Stegun 7.1.26 approximation to the error function.
 * Max error ~1.5e-7 — more than enough for pricing.
 *
 * @param {number} x
 * @returns {number}
 */
export function erf(x) {
  if (!Number.isFinite(x)) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Standard normal CDF (Φ) and PDF (φ) and the general-normal helpers
 * built on them. Kept as named exports so callers can spot-check inputs
 * without re-deriving the math.
 *
 * @param {number} x
 * @returns {number}
 */
export function normalCdf(x, mean = 0, std = 1) {
  if (!Number.isFinite(x) || !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) return 0;
  return 0.5 * (1 + erf((x - mean) / (std * Math.SQRT2)));
}

/**
 * @param {number} x
 * @param {number} [mean]
 * @param {number} [std]
 * @returns {number}
 */
export function normalPdf(x, mean = 0, std = 1) {
  if (!Number.isFinite(x) || !Number.isFinite(mean) || !Number.isFinite(std) || std <= 0) return 0;
  const z = (x - mean) / std;
  return Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI));
}

/**
 * Closed-form expected stop-loss premium E[(X − K)+] for X ~ N(μ, σ²):
 *   E[(X − K)+] = (μ − K)·Φ((μ − K)/σ) + σ·φ((μ − K)/σ)
 *
 * @param {number} mean
 * @param {number} std
 * @param {number} K     Retention (priority).
 * @returns {number}
 */
export function normalStopLossPremium(mean, std, K) {
  if (!Number.isFinite(mean) || !Number.isFinite(std) || !Number.isFinite(K)) return 0;
  if (std <= 0) return Math.max(0, mean - K);
  const z = (mean - K) / std;
  return (mean - K) * normalCdf(z) + std * normalPdf(z);
}

/**
 * Expected loss in an aggregate layer [D, D+L] under a normal
 * approximation to the aggregate distribution:
 *   E[min(max(S − D, 0), L)] = π(D) − π(D + L)
 * where π(K) = E[(S − K)+] is the Normal stop-loss premium above.
 *
 * @param {number} mean   E[S]
 * @param {number} std    √Var[S]
 * @param {number} D      attachment / priority
 * @param {number} L      layer width
 * @returns {number} expected layer loss; 0 for invalid input or L ≤ 0.
 */
export function normalLayerMean(mean, std, D, L) {
  if (!Number.isFinite(L) || L <= 0) return 0;
  if (!Number.isFinite(mean) || !Number.isFinite(std) || !Number.isFinite(D)) return 0;
  return normalStopLossPremium(mean, std, D) - normalStopLossPremium(mean, std, D + L);
}

/**
 * Parameters of the underlying Normal for a Lognormal severity given
 * its mean and coefficient of variation:
 *   σ² = ln(1 + CV²),  μ = ln(mean) − σ²/2.
 *
 * @param {number} mean  E[X] > 0
 * @param {number} cv    CV = σ_X / mean ≥ 0
 * @returns {{mu: number, sigma: number}|null} null for invalid input.
 */
export function lognormalFromMeanCv(mean, cv) {
  if (!Number.isFinite(mean) || mean <= 0) return null;
  if (!Number.isFinite(cv) || cv < 0) return null;
  const sigma2 = Math.log(1 + cv * cv);
  return { mu: Math.log(mean) - sigma2 / 2, sigma: Math.sqrt(sigma2) };
}

/**
 * First two raw moments of a Lognormal(μ, σ²) severity.
 *   E[X]  = exp(μ + σ²/2)
 *   E[X²] = exp(2μ + 2σ²)
 *
 * @param {number} mu
 * @param {number} sigma
 * @returns {{mean: number, secondMoment: number, variance: number}}
 */
export function lognormalMoments(mu, sigma) {
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma < 0) {
    return { mean: 0, secondMoment: 0, variance: 0 };
  }
  const mean = Math.exp(mu + (sigma * sigma) / 2);
  const secondMoment = Math.exp(2 * mu + 2 * sigma * sigma);
  return { mean, secondMoment, variance: secondMoment - mean * mean };
}

/**
 * First two raw moments of a single-parameter Pareto severity with
 * shape α and scale (minimum) θ; P(X > x) = (θ/x)^α for x ≥ θ.
 *   E[X]  = αθ/(α − 1)        for α > 1, else Infinity
 *   E[X²] = αθ²/(α − 2)       for α > 2, else Infinity
 *
 * Heavy-tailed cases (α ≤ 2) return Infinity for the affected moment
 * so the caller knows the Normal approximation will mis-price the tail.
 *
 * @param {number} alpha
 * @param {number} theta
 * @returns {{mean: number, secondMoment: number, variance: number}}
 */
export function paretoMoments(alpha, theta) {
  if (!Number.isFinite(alpha) || !Number.isFinite(theta) || theta <= 0 || alpha <= 0) {
    return { mean: 0, secondMoment: 0, variance: 0 };
  }
  const mean = alpha > 1 ? (alpha * theta) / (alpha - 1) : Infinity;
  const secondMoment = alpha > 2 ? (alpha * theta * theta) / (alpha - 2) : Infinity;
  const variance = Number.isFinite(secondMoment) && Number.isFinite(mean)
    ? secondMoment - mean * mean
    : Infinity;
  return { mean, secondMoment, variance };
}

/**
 * Mean and variance of an aggregate annual loss S under a Compound
 * Poisson model (N ~ Poisson(λ); claim sizes iid with given moments).
 *   E[S]   = λ · E[X]
 *   Var[S] = λ · E[X²]            (NOT λ·Var[X] — Wald's variance)
 *
 * @param {number} lambda          Poisson rate (expected claim count).
 * @param {number} severityMean    E[X]
 * @param {number} severitySecondMoment  E[X²]
 * @returns {{mean: number, variance: number, std: number}}
 */
export function compoundPoissonMoments(lambda, severityMean, severitySecondMoment) {
  if (!Number.isFinite(lambda) || lambda < 0) return { mean: 0, variance: 0, std: 0 };
  if (!Number.isFinite(severityMean)) return { mean: 0, variance: 0, std: 0 };
  if (!Number.isFinite(severitySecondMoment)) {
    return { mean: lambda * severityMean, variance: Infinity, std: Infinity };
  }
  const mean = lambda * severityMean;
  const variance = lambda * severitySecondMoment;
  return { mean, variance, std: Math.sqrt(variance) };
}
