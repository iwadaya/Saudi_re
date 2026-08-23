// @ts-check
/**
 * npPricingEngine.js
 * ─────────────────────────────────────────────────────────────────
 * Actuarial engine for Non-Proportional treaty pricing.
 *
 * Three methods per layer:
 *   1. Pure Burning Cost  — limited excess losses over deductible / EGNPI → ROL %
 *   2. Pareto             — fit Pareto to selected losses above threshold,
 *                           compute E[X xs D, lim L] using LEV formula → ROL %
 *   3. Exposure Rating    — Risk XL: MBBEFD risk curve per band
 *                           Cat XL : CRESTA aggregate exposure × peril rate
 *
 * All functions are pure / synchronous given pre-fetched data objects.
 * The async orchestrator `calcLayerPricing(...)` fetches all data once
 * and returns the full result set for all layers.
 *
 * Low-level math primitives (layer hit, annualisation, ROL, loading
 * blend) live in /shared/pricingMath.js so the server can validate
 * client-submitted numbers against identical formulas — see
 * re-exports below.
 */

import { toN } from './format.js';
import { layerHit } from '../../../shared/pricingMath.js';

/**
 * @typedef {import('../types/pricing').LossLike} LossLike
 * @typedef {import('../types/pricing').LossSelectionSnapshot} LossSelectionSnapshot
 * @typedef {import('../types/pricing').RiskProfileHeader} RiskProfileHeader
 * @typedef {import('../types/pricing').ProfilePoint} ProfilePoint
 *
 * One COB's risk profile as consumed by the MBBEFD exposure rating.
 * @typedef {{ profile: RiskProfileHeader, bands: ProfilePoint[] }} RiskProfileInput
 *
 * Common result of one pricing method for one layer (rates are decimals).
 * @typedef {{ rol: number, prAttach?: number, prExhaust?: number, [extra: string]: unknown }} MethodResult
 *
 * UI-shaped layer rows fed in by the screens (formatted strings allowed —
 * every numeric field goes through cn() before math).
 * @typedef {{ deductible?: unknown, limit?: unknown, egnpi?: unknown,
 *             risk?: unknown, cat?: unknown, riskCover?: unknown, catCover?: unknown,
 *             classOfBusinessIds?: unknown, class_of_business_ids?: unknown }} EngineLayer
 */

// Re-export the shared primitives so callers can pull everything from
// one module. The shared versions are covered by their own test suite
// and are the authority when the implementations below need to change.
export {
  layerHit,
  annualiseLoss,
  rolFromAnnualLoss,
  applyLoading,
} from '../../../shared/pricingMath.js';

// ── Maths helpers ─────────────────────────────────────────────────

/**
 * Safe number parse
 * @param {unknown} v
 * @returns {number}
 */
export function cn(v) {
  return toN(v);
}

/**
 * Format as ROL % string, 4dp
 * @param {number} v
 * @returns {string}
 */
export function fmtRol(v) {
  if (!v || !Number.isFinite(v) || v <= 0) return '';
  return (v * 100).toFixed(2) + '%';
}

/**
 * Format as rate % string, 4dp
 * @param {number} v
 * @returns {string}
 */
export function fmtPct(v) {
  if (!v || !Number.isFinite(v) || v <= 0) return '';
  return (v * 100).toFixed(2) + '%';
}

// ── MBBEFD (Swiss Re exposure curve) ──────────────────────────────
// G(d,c) = log(1 + (e^c - 1)*d) / c   where d = damage ratio ∈ [0,1]
/**
 * @param {number} d damage ratio ∈ [0,1]
 * @param {number} c curve parameter
 * @returns {number}
 */
export function mbbefdG(d, c) {
  if (d <= 0) return 0;
  if (d >= 1) return 1;
  if (Math.abs(c) < 1e-10) return d;   // c≈0 → linear
  return Math.log(1 + (Math.exp(c) - 1) * d) / c;
}
// Swiss Re Y-curve mapping
export const SWISS_RE_C = /** @type {Record<string, number>} */ ({ Y1: 0, Y2: 1.5, Y3: 3.0, Y4: 5.0 });

/**
 * MBBEFD Limited Expected Value (LEV) for a layer [D, D+L] on a single risk of SI
 * with PML% and curve parameter c.
 *
 * E[min(max(X-D,0), L)] ≈ SI × PML_pct × [G(min((D+L)/PML,1),c) - G(min(D/PML,1),c)]
 *
 * @param {number} si
 * @param {number} pmlPct
 * @param {number} cValue
 * @param {number} deductible
 * @param {number} limit
 * @returns {number}
 */
export function mbbefdLayerLEV(si, pmlPct, cValue, deductible, limit) {
  if (si <= 0 || limit <= 0) return 0;
  const pml = si * (pmlPct / 100);
  if (pml <= 0) return 0;
  const dRatio  = Math.min(deductible / pml, 1);
  const dlRatio = Math.min((deductible + limit) / pml, 1);
  return pml * (mbbefdG(dlRatio, cValue) - mbbefdG(dRatio, cValue));
}

// ── Pareto helpers ─────────────────────────────────────────────────
/**
 * MLE fit of Pareto(α, xm) to a loss array.
 * Uses only losses ≥ xm (threshold).
 *
 * @param {number[]} losses
 * @param {number} xm
 * @returns {{ alpha: number, n: number }}
 */
export function fitPareto(losses, xm) {
  const v = (losses || []).filter(l => l >= xm);
  const n = v.length;
  if (n === 0) return { alpha: 0, n: 0 };
  let s = 0;
  for (const x of v) s += Math.log(x / xm);
  return { alpha: s > 0 ? n / s : 0, n };
}

/**
 * Pareto quantile: the loss at exceedance probability p
 * (i.e. 1-in-(1/p) event).
 *
 * @param {number} p
 * @param {number} alpha
 * @param {number} xm
 * @returns {number}
 */
export function paretoQ(p, alpha, xm) {
  if (!(p > 0 && p < 1) || !(alpha > 0) || !(xm > 0)) return 0;
  return xm * Math.pow(1 - p, -1 / alpha);
}

/**
 * Pareto Limited Expected Value for layer [D, D+L] given fitted (alpha, xm).
 *
 * E[min(max(X-D,0), L)] = E[min(X, D+L)] - E[min(X, D)]
 *
 * For Pareto(α, xm):
 *   E[min(X, c)] = xm*α/(α-1) * [1 - (xm/c)^(α-1)] + c*(xm/c)^α   for α≠1
 *   E[min(X, c)] = xm * (1 + ln(c/xm))                               for α=1
 *
 * Only valid for X ≥ xm; losses below xm are handled separately.
 *
 * @param {number} alpha
 * @param {number} xm
 * @param {number} cap
 * @returns {number}
 */
export function paretoLEV(alpha, xm, cap) {
  if (cap <= 0 || alpha <= 0 || xm <= 0) return 0;
  if (cap <= xm) return cap;  // below threshold — pure limited value
  if (Math.abs(alpha - 1) < 1e-9) {
    return xm * (1 + Math.log(cap / xm));
  }
  return (xm * alpha / (alpha - 1)) * (1 - Math.pow(xm / cap, alpha - 1))
    + cap * Math.pow(xm / cap, alpha);
}

/**
 * Expected loss in layer [D, D+L] from Pareto(alpha, xm) fitted to the tail.
 * Accounts for the frequency of large losses relative to total exposure years.
 *
 * E[layer cost per risk-year] = (n / years) * (LEV(D+L) - LEV(D))
 *
 * @param {number} alpha
 * @param {number} xm
 * @param {number} deductible
 * @param {number} limit
 * @param {number} n     count of fitted tail losses
 * @param {number} years total observation window (zero-loss years included)
 * @returns {number}
 */
export function paretoLayerExpectedLoss(alpha, xm, deductible, limit, n, years) {
  if (alpha <= 0 || years <= 0 || n <= 0) return 0;
  const D = Math.max(deductible, xm);   // Pareto only models X ≥ xm
  const levTop = paretoLEV(alpha, xm, D + limit);
  const levBot = paretoLEV(alpha, xm, D);
  return (n / years) * (levTop - levBot);
}

/**
 * Probability of attachment: P(X > D) for a Pareto tail
 * @param {number} alpha
 * @param {number} xm
 * @param {number} deductible
 * @returns {number}
 */
export function paretoAttachment(alpha, xm, deductible) {
  if (alpha <= 0 || xm <= 0 || deductible <= xm) return 1;
  return Math.pow(xm / deductible, alpha);
}

/**
 * Probability of exhaustion: P(X > D+L) for a Pareto tail
 * @param {number} alpha
 * @param {number} xm
 * @param {number} deductible
 * @param {number} limit
 * @returns {number}
 */
export function paretoExhaustion(alpha, xm, deductible, limit) {
  return paretoAttachment(alpha, xm, deductible + limit);
}

// ── Pure Burning Cost ──────────────────────────────────────────────
/**
 * Calculate pure burning cost for a layer [deductible, deductible+limit].
 *
 * Clark (2014) Steps 2–5:
 *   1. Take selected losses (incurred, inflation-adjusted).
 *   2. For each loss, cut to the layer: max(0, min(loss-D, L)).
 *   3. Sum layer losses per year.
 *   4. Divide each year's layer loss by that year's on-level EGNPI
 *      → loss cost % for that year.
 *   5. Average loss costs across all observation years (including zero-loss years)
 *      → average loss cost as % of EGNPI.
 *   6. ROL = avgAnnualLayerLoss / limit  (true Rate-on-Line).
 *
 * @param {LossLike[]} losses     - Array of {uw_year, incurred, inflated_incurred, inflation_factor, is_selected}
 * @param {number} deductible  - Layer attachment (same currency as losses)
 * @param {number} limit       - Layer width
 * @param {number} egnpi       - Current-year EGNPI (fallback when no per-year data)
 * @param {number} obsYears    - Number of observation years (covers zero-loss years)
 * @param {Record<string|number, unknown>} [egnpiByYear] - Map of { year: egnpi } from NpPremiumsTable (optional)
 * @returns {{ rol: number, avgAnnualLayerLoss: number, avgLossCost?: number, avgEgnpi?: number, totalLayerLoss?: number, years?: number }}
 */
export function calcPureBurningCost(losses, deductible, limit, egnpi, obsYears, egnpiByYear) {
  if (!losses?.length || limit <= 0) return { rol: 0, avgAnnualLayerLoss: 0 };

  const selected = losses.filter(l => l.is_selected !== false);

  // Use inflated_incurred if available, else incurred + os
  const withValues = selected.map(l => ({
    year: l.uw_year,
    loss: cn(l.inflated_incurred) || (cn(l.incurred) + cn(l.os)),
  })).filter(l => l.loss > 0);

  if (!withValues.length) return { rol: 0, avgAnnualLayerLoss: 0 };

  // Step 2–3: apply deductible, cap at limit, sum by year
  const byYear = /** @type {Record<string, number>} */ ({});
  for (const { year, loss } of withValues) {
    byYear[String(year)] = (byYear[String(year)] || 0) + layerHit(loss, deductible, limit);
  }

  const totalLayerLoss = Object.values(byYear).reduce((s, v) => s + v, 0);

  // Steps 4–5: per-year loss cost using year-matched EGNPI (Clark alignment)
  // If egnpiByYear is provided, compute loss cost per year and average.
  // Fall back to single-egnpi method if no per-year data available.
  const hasPerYearEgnpi = egnpiByYear && Object.keys(egnpiByYear).length > 0;

  let avgLossCost, avgEgnpi, years;

  if (hasPerYearEgnpi) {
    // Collect all observation years: union of loss years and egnpi years
    const allYears = new Set([
      ...Object.keys(byYear).map(Number),
      ...Object.keys(egnpiByYear).map(Number),
    ]);
    years = obsYears || allYears.size || 1;

    // Sum loss costs across years that have EGNPI; zero-loss years contribute 0
    let totalLossCost = 0;
    let egnpiSum = 0;
    let egnpiCount = 0;
    for (const y of allYears) {
      const yEgnpi = cn(egnpiByYear[y]);
      if (yEgnpi > 0) {
        const yLayerLoss = byYear[y] || 0;
        totalLossCost += yLayerLoss / yEgnpi;
        egnpiSum += yEgnpi;
        egnpiCount++;
      }
    }
    avgLossCost = years > 0 ? totalLossCost / years : 0;
    avgEgnpi    = egnpiCount > 0 ? egnpiSum / egnpiCount : cn(egnpi);
  } else {
    // Fallback: single current-year EGNPI (prior behaviour)
    years = obsYears || Object.keys(byYear).length || 1;
    avgEgnpi    = cn(egnpi);
    avgLossCost = avgEgnpi > 0 ? (totalLayerLoss / years) / avgEgnpi : 0;
  }

  // Step 6: apply the loss-cost rate to PROSPECTIVE EGNPI (Clark §6).
  //
  // Previously this multiplied avgLossCost × avgEgnpi (historical mean) and
  // then divided by limit. Two problems with that:
  //   (a) Bias — avgLossCost × avgEgnpi is not an unbiased estimator of the
  //       mean annual layer loss when EGNPI varies year-by-year. Counter-
  //       example: layer hits = [100, 0], egnpi = [100, 1000] → old code
  //       returned avgAnnualLayerLoss = 275, true mean = 50.
  //   (b) Unit mismatch — Pareto and exposure rating return loss / EGNPI;
  //       this branch returned loss / limit. The blend in deriveComponentTotal
  //       then summed mismatched units.
  //
  // avgAnnualLayerLoss = avgLossCost × prospective_EGNPI gives the expected
  // annual layer loss in currency, then
  // rol = avgAnnualLayerLoss / limit — true Rate-on-Line, consistent with
  // Pareto and exposure rating which also divide expected layer loss by limit.
  const prospectiveEgnpi = cn(egnpi);
  const avgAnnualLayerLoss = avgLossCost * prospectiveEgnpi;
  const rol = limit > 0 ? avgAnnualLayerLoss / limit : 0;

  return { rol, avgLossCost, avgAnnualLayerLoss, avgEgnpi, totalLayerLoss, years };
}

// ── Pareto Pricing ─────────────────────────────────────────────────
/**
 * Pareto pricing for a layer.
 *
 * Fits a Pareto to selected losses above a threshold xm (defaults to 25th
 * percentile of loss distribution).  Uses LEV to price the layer.
 *
 * Returns rol = expectedAnnualLayerLoss / limit (a fraction) — the true
 * Rate-on-Line, the SAME ÷ limit basis as calcPureBurningCost and the
 * exposure-rating functions, so the three are unit-consistent and blend
 * directly. (NOT ÷ EGNPI — that would be a rate, a different unit.)
 *
 * @param {LossLike[]} losses     - same as above
 * @param {number} deductible
 * @param {number} limit
 * @param {number} egnpi
 * @param {LossSelectionSnapshot} [savedParams] - Optional saved {pareto_xm, pareto_alpha, observation_years}
 *                               from the loss selection screen (takes precedence if present)
 * @returns {{ rol: number, alpha: number, xm: number, prAttach: number, prExhaust: number, expLayerLoss?: number }}
 */
export function calcParetoROL(losses, deductible, limit, egnpi, savedParams) {
  if (limit <= 0 || egnpi <= 0) return { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };

  let alpha, xm, n, years;

  // Prefer saved fitted params from loss selection screen.
  // (NUMERIC columns arrive as strings — coerce before comparing, otherwise
  // '"5" > 0' style coercion comparisons hide formatting bugs.)
  if (savedParams && cn(savedParams.pareto_alpha) > 0 && cn(savedParams.pareto_xm) > 0) {
    alpha = cn(savedParams.pareto_alpha);
    xm    = cn(savedParams.pareto_xm);
    n     = cn(savedParams.selected_count) || 10;
    years = cn(savedParams.observation_years) || 10;
  } else {
    // Fit from raw losses
    const selected = (losses || []).filter(l => l.is_selected !== false);
    const vals = selected.map(l => cn(l.inflated_incurred) || cn(l.incurred) + cn(l.os)).filter(v => v > 0);
    if (vals.length < 3) return { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };

    const sorted = [...vals].sort((a, b) => a - b);
    // Use 25th percentile as threshold xm (focus on heavy tail)
    xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
    const fit = fitPareto(vals, xm);
    alpha = fit.alpha;
    n     = fit.n;
    years = cn(savedParams?.observation_years) || Math.max(5, new Set(selected.map(l => l.uw_year)).size);
  }

  if (alpha <= 0) return { rol: 0, alpha: 0, xm: 0, prAttach: 0, prExhaust: 0 };

  // Expected layer cost per year
  const expLayerLoss = paretoLayerExpectedLoss(alpha, xm, deductible, limit, n, years);
  const rol = limit > 0 ? expLayerLoss / limit : 0;

  // Probability of attachment and exhaustion
  const prAttach  = Math.min(1, paretoAttachment(alpha, xm, deductible));
  const prExhaust = Math.min(1, paretoExhaustion(alpha, xm, deductible, limit));

  return { rol, alpha, xm, prAttach, prExhaust, expLayerLoss };
}

// ── Swiss Re band-size → curve mapping (brochure p.17) ────────────
// Thresholds are in treaty currency units; scaled generously per the
// original CHF values (approx USD/SAR equivalents).
// Mean SI/MPL per band determines which Y-curve applies.
const BAND_CURVE_THRESHOLDS = [
  { maxSI: 400_000,   curve: 'Y1' },  // Personal lines
  { maxSI: 1_000_000, curve: 'Y2' },  // Commercial small
  { maxSI: 2_000_000, curve: 'Y3' },  // Commercial medium
];
// > 2M → Y4 (industrial/large commercial)

/**
 * Select the appropriate Swiss Re Y-curve for a band based on its mean SI/MPL.
 * Implements Swiss Re brochure Step 4 (p.20): choose curve per band by risk size.
 * @param {number} avgSI
 * @returns {string}
 */
export function autoCurveForBand(avgSI) {
  for (const { maxSI, curve } of BAND_CURVE_THRESHOLDS) {
    if (avgSI <= maxSI) return curve;
  }
  return 'Y4';
}

// ── Risk XL Exposure Rating (MBBEFD) ──────────────────────────────
/**
 * Exposure rating for Risk XL using MBBEFD risk curves.
 * Implements Swiss Re brochure 9-step procedure (Steps 1–9).
 *
 * Step 4 (auto-curve): when profile.selected_curve === 'Auto', the
 *   Y-curve is selected per band based on mean SI vs Swiss Re size thresholds.
 *   Otherwise the single saved curve is applied to all bands (legacy behaviour).
 *
 * Step 8 (loss ratio): totalExpLoss is multiplied by profile.gross_loss_ratio
 *   (expressed as a %) before computing ROL. If not provided, defaults to 100%
 *   (no adjustment) to preserve backward compatibility.
 *
 * @param {RiskProfileInput[]} profiles - [{profile: {c_value, pml_percentage, selected_curve,
 *                                          custom_b, gross_loss_ratio},
 *                                bands: [{from_amt, to_amt, no_of_risks, total_sum_insured}]}]
 * @param {number} deductible
 * @param {number} limit
 * @param {number} egnpi
 * @returns {{ rol: number, totalExpLoss: number, totalSI?: number }}
 */
export function calcRiskExposureRating(profiles, deductible, limit, egnpi) {
  if (!profiles?.length || limit <= 0 || egnpi <= 0) {
    return { rol: 0, totalExpLoss: 0 };
  }

  let totalExpLoss = 0;
  let totalSI = 0;

  for (const { profile, bands } of profiles) {
    if (!bands?.length) { console.warn('[MBBEFD] profile has no bands:', profile); continue; }
    const pmlPct   = cn(profile.pml_percentage) || 100;
    const curveKey = profile.selected_curve || 'Y3';
    const useAuto  = curveKey === 'Auto';

    // Step 8: gross loss ratio multiplier (Swiss Re brochure p.22)
    // profile.gross_loss_ratio is stored as a percentage (e.g. 55 = 55%)
    // Default to 100 so legacy profiles without this field are unaffected.
    const grossLossRatio = cn(profile.gross_loss_ratio) > 0
      ? cn(profile.gross_loss_ratio) / 100
      : 1.0;

    for (const band of bands) {
      const nRisks = cn(band.no_of_risks);
      const si     = cn(band.total_sum_insured);
      if (nRisks <= 0 || si <= 0) continue;
      const avgSI = si / nRisks;
      if (!Number.isFinite(avgSI) || avgSI <= 0) continue;

      // Step 4: per-band curve selection when Auto mode is on
      const bandCurveKey = useAuto ? autoCurveForBand(avgSI) : curveKey;
      const c = bandCurveKey === 'Custom'
        ? cn(profile.custom_b)
        : (SWISS_RE_C[bandCurveKey] ?? 3.0);

      totalSI += si;
      const lev = mbbefdLayerLEV(avgSI, pmlPct, c, deductible, limit);
      totalExpLoss += nRisks * lev;
    }

    // Step 8: apply gross loss ratio to convert gross XL premium to risk premium
    totalExpLoss *= grossLossRatio;
  }

  const rol = (totalSI > 0 && limit > 0) ? totalExpLoss / limit : 0;
  return { rol, totalExpLoss, totalSI };
}

// ── Cat XL Exposure Rating (CRESTA-based) ─────────────────────────
/**
 * CAT exposure rating using CRESTA zone aggregates.
 *
 * Method:
 *   1. Total exposure (TIV) per peril from CRESTA zones.
 *   2. Apply peril-specific damage rates (from cat losses or market benchmarks).
 *   3. Expected annual aggregate loss = sum over zones of TIV × zone_rate.
 *   4. Layer loss = E[min(max(agg_loss - D, 0), L)] using normal approximation.
 *
 * In practice: if we have saved return-period points from the cat loss screen,
 * we use those directly (preferred). Otherwise we derive from CRESTA exposure.
 *
 * @param {Array<Record<string, unknown>>} crestaRows - [{eq_agg, ws_agg, flood_agg, srcc_agg, others_agg}]
 * @param {number} deductible
 * @param {number} limit
 * @param {number} egnpi
 * @param {LossSelectionSnapshot} [catSnap] - saved loss-selection snapshot {return_period_key_points, ...}
 * @param {LossLike[]} [catLosses] - raw cat loss events [{incurred, uw_year, is_selected}]
 * @param {number} [obsYears]
 * @returns {MethodResult & { method?: string }}
 */
export function calcCatExposureRating(crestaRows, deductible, limit, egnpi, catSnap, catLosses, obsYears) {
  if (limit <= 0 || egnpi <= 0) return { rol: 0, totalExposure: 0 };

  // ── Method 1: saved return-period curve (most accurate) ──────────
  if (catSnap?.return_period_key_points) {
    const kp = /** @type {Record<string, unknown>} */ (catSnap.return_period_key_points);
    // Use OEP (Occurrence Exceedance Probability) curve points
    // Layer expected loss ≈ sum_i { P(loss_i) × layer_hit_i }
    // Simplified: use RP10 and RP50 anchor points
    const rp10  = cn(kp.rp10);
    const rp25  = cn(kp.rp25);
    const rp50  = cn(kp.rp50);
    const rp100 = cn(kp.rp100);
    const rp200 = cn(kp.rp200);

    if (rp10 > 0 || rp50 > 0) {
      // Trapezoidal integration over the OEP curve
      // Layer hit at each RP = max(0, min(event_loss - D, L))
      const points = [
        { rp: 1,   loss: 0 },
        { rp: 5,   loss: rp10  > 0 ? rp10  * 0.4 : 0 },  // interpolate RP5
        { rp: 10,  loss: rp10  || 0 },
        { rp: 25,  loss: rp25  || (rp10 && rp50 ? (rp10 + rp50) / 2 : 0) },
        { rp: 50,  loss: rp50  || 0 },
        { rp: 100, loss: rp100 || (rp50  ? rp50  * 1.5 : 0) },
        { rp: 200, loss: rp200 || (rp100 ? rp100 * 1.4 : 0) },
        { rp: 500, loss: rp200 ? rp200 * 1.5 : 0 },
      ].filter(p => p.loss > 0);

      let aep = 0; // Annual Expected Loss from layer
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i],   p2 = points[i + 1];
        const f1 = 1 / p1.rp,  f2 = 1 / p2.rp;
        const h1 = layerHit(p1.loss, deductible, limit);
        const h2 = layerHit(p2.loss, deductible, limit);
        aep += (f1 - f2) * (h1 + h2) / 2;
      }
      const rol = limit > 0 ? aep / limit : 0;
      // Prob attachment / exhaustion: interpolate from OEP curve
      const prAttach  = interpOEP(points, deductible);
      const prExhaust = interpOEP(points, deductible + limit);
      return { rol, aep, prAttach, prExhaust, method: 'rp_curve' };
    }
  }

  // ── Method 2: Pareto fit on cat losses ───────────────────────────
  if ((catLosses?.length || 0) >= 3 && catLosses) {
    const selected = catLosses.filter(l => l.is_selected !== false);
    const vals = selected.map(l => cn(l.inflated_incurred) || cn(l.incurred) + cn(l.os)).filter(v => v > 0);
    if (vals.length >= 3) {
      const sorted = [...vals].sort((a, b) => a - b);
      const xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
      const { alpha, n } = fitPareto(vals, xm);
      const years = obsYears || Math.max(5, new Set(selected.map(l => l.uw_year)).size);
      if (alpha > 0) {
        const expLayerLoss = paretoLayerExpectedLoss(alpha, xm, deductible, limit, n, years);
        const rol = limit > 0 ? expLayerLoss / limit : 0;
        const prAttach  = Math.min(1, paretoAttachment(alpha, xm, deductible));
        const prExhaust = Math.min(1, paretoExhaustion(alpha, xm, deductible, limit));
        return { rol, alpha, xm, prAttach, prExhaust, expLayerLoss, method: 'pareto' };
      }
    }
  }

  // ── Method 3: flat-loss-ratio fallback gated on CRESTA presence ──
  // We don't yet implement a true exposure calculation (per-peril damage
  // rate × per-zone TIV); until we do, fall back to a 15% expected-loss
  // assumption layered over deductible/limit. CRESTA totals act only as
  // a *gate*: with no exposure recorded we return method='none' so the
  // caller can flag the layer as un-priced. The method name is
  // explicit so callers don't mistake this for a real exposure rating.
  if (crestaRows?.length) {
    const totalExposure = crestaRows.reduce((s, r) =>
      s + cn(r.eq_agg) + cn(r.ws_agg) + cn(r.flood_agg) + cn(r.srcc_agg) + cn(r.others_agg), 0);
    if (totalExposure > 0 && egnpi > 0) {
      const impliedLoss = egnpi * 0.15; // base: 15% expected annual loss ratio as seed
      const rol = limit > 0
        ? layerHit(impliedLoss, deductible, limit) / (limit * (obsYears || 10))
        : 0;
      return { rol, totalExposure, method: 'flat_loss_ratio_fallback' };
    }
  }

  return { rol: 0, method: 'none' };
}

/**
 * Interpolate exceedance probability from OEP curve points
 * @param {{ rp: number, loss: number }[]} points
 * @param {number} loss
 * @returns {number}
 */
function interpOEP(points, loss) {
  if (!points?.length || loss <= 0) return 0;
  if (loss <= points[0].loss) return 1 / points[0].rp;
  if (loss >= points[points.length - 1].loss) return 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i], p2 = points[i + 1];
    if (loss >= p1.loss && loss <= p2.loss) {
      const t = (loss - p1.loss) / (p2.loss - p1.loss);
      return 1 / (p1.rp + t * (p2.rp - p1.rp));
    }
  }
  return 0;
}


// ── Master orchestrator ──────────────────────────────────────────────────────
/**
 * calcLayerPricing
 *
 * Fetches all required data and runs pricing independently for RISK and CAT
 * components of every NP layer.
 *
 * For layers that carry both covers (BOTH mode) the engine produces two
 * independent sets of actuarial results:
 *   risk: large losses + risk Pareto + MBBEFD exposure rating
 *   cat:  cat losses  + cat Pareto  + CRESTA/return-period exposure rating
 *
 * The calling screen sums riskUwPrice + catUwPrice to get the combined
 * layer UW price.  Layers with only one cover get only that component.
 *
 * @returns {Promise<Array>}  one result per layer with shape { idx, risk, cat }
 */

/**
 * Normalise a class-of-business label/code for matching: lowercase, strip
 * punctuation to spaces, collapse internal whitespace, trim. Applied IDENTICALLY
 * to the catalog tokens and the loss's text so "Political Violence",
 * "political-violence" and "Political  Violence" all compare equal.
 * @param {unknown} value
 * @returns {string}
 */
function normCob(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// COB id field aliases (a catalog row / loss may carry any of these) and the
// name/code fields we tokenize. listClassOfBusiness aliases the id to `id`.
const COB_ID_KEYS = ['class_of_business_id', 'id', 'cob_id', 'class_id'];
const COB_NAME_KEYS = ['class_of_business', 'class_name', 'name', 'code', 'class_code'];

/**
 * Build a map of `cobId → Set<match token>` from the reference
 * `class_of_business` list. Each token is a NORMALISED name / code that a loss
 * row might carry, keyed under every id alias the row exposes.
 * Exposed so filterLossesForLayer can be unit-tested in isolation.
 * @param {unknown} cobList
 * @returns {Record<string, Set<string>>}
 */
export function buildCobTokenMap(cobList) {
  const map = /** @type {Record<string, Set<string>>} */ ({});
  for (const c of (Array.isArray(cobList) ? cobList : [])) {
    const tokens = new Set();
    for (const key of COB_NAME_KEYS) {
      const t = normCob(c?.[key]);
      if (t) tokens.add(t);
    }
    if (!tokens.size) continue;
    // Key under EVERY id alias the row exposes so the lookup hits whichever id
    // space the layers carry. listClassOfBusiness aliases class_of_business_id →
    // `id`, and selectedCobs[].id / layer class_of_business_ids are that same id.
    for (const idKey of COB_ID_KEYS) {
      const id = String(c?.[idKey] ?? '').trim();
      if (!id) continue;
      if (!map[id]) map[id] = new Set();
      for (const t of tokens) map[id].add(t);
    }
  }
  return map;
}

/**
 * Reverse index: normalised COB name/code → COB id, built from the same catalog.
 * Lets us resolve a loss's free-text class_of_business to a COB id at load, so
 * routing is id-based (loss tables store only the text name today). First id wins
 * on a token collision.
 * @param {unknown} cobList
 * @returns {Map<string, string>}
 */
export function buildCobNameToId(cobList) {
  const map = new Map();
  for (const c of (Array.isArray(cobList) ? cobList : [])) {
    let id = '';
    for (const idKey of COB_ID_KEYS) {
      const v = String(c?.[idKey] ?? '').trim();
      if (v) { id = v; break; }
    }
    if (!id) continue;
    for (const key of COB_NAME_KEYS) {
      const t = normCob(c?.[key]);
      if (t && !map.has(t)) map.set(t, id);
    }
  }
  return map;
}

/**
 * Filter losses so only those whose class-of-business matches one of the layer's
 * covered COBs remain. A loss burns a layer when its COB **id** ∈ layerCobIds
 * (authoritative — the id is native or resolved from text at load). The
 * normalised-NAME match is a fallback used ONLY when the loss carries no id.
 * Conservative fall-throughs (never silently drop burn signal):
 *   - layer with no classOfBusinessIds → pass all (no layer-COB linkage set up)
 *   - loss with no id AND no name → pass through
 *   - loss with no id and a name, but the catalog resolved no tokens → pass through
 *
 * @param {LossLike[]} losses
 * @param {Array<string>} layerCobIds
 * @param {Record<string, Set<string>>} cobIdToTokens  from buildCobTokenMap
 * @returns {LossLike[]}
 */
export function filterLossesForLayer(losses, layerCobIds, cobIdToTokens) {
  if (!Array.isArray(losses) || !losses.length) return losses || [];
  if (!Array.isArray(layerCobIds) || !layerCobIds.length) return losses;
  const allowedIds = new Set(layerCobIds.map((id) => String(id).trim()).filter(Boolean));
  const allowedTokens = new Set();
  for (const id of allowedIds) {
    const tokens = cobIdToTokens?.[id];
    if (tokens) for (const t of tokens) allowedTokens.add(t);
  }
  return losses.filter((l) => {
    // 1) ID match is authoritative — a loss carrying a COB id (native or resolved
    //    at load via _cobId) burns ONLY layers whose covered COBs include that id.
    const lossId = String(l?.cob_id ?? l?.class_of_business_id ?? l?._cobId ?? '').trim();
    if (lossId) return allowedIds.has(lossId);
    // 2) Name fallback — ONLY when the loss has no id.
    const name = normCob(l?.class_of_business ?? l?.classOfBusiness);
    if (!name) return true;                 // no id, no name → can't exclude
    if (!allowedTokens.size) return true;   // catalog miss → don't silently drop
    return allowedTokens.has(name);
  });
}

/**
 * @param {import('../api').Api} api
 * @param {string} contractId
 * @param {EngineLayer[]} layers
 * @param {{ estGnpi?: unknown }} npDetail
 * @param {string} mode  'RISK' | 'CAT' | 'BOTH'
 * @param {boolean} [quoteMode]
 */
export async function calcLayerPricing(api, contractId, layers, npDetail, mode, quoteMode) {
  const qm = quoteMode ? { quote: true } : undefined;

  const needRisk = mode !== 'CAT';
  const needCat  = mode !== 'RISK';

  /** @type {Partial<import('../types/pricing').LossReportBundle>} */
  const emptyLossBundle = {};
  /** @type {Partial<import('../types/pricing').LossSelectionBundle>} */
  const emptySelection = {};

  const [
    largeLossData,
    catLossData,
    llSnap,
    catSnap,
    crestaData,
    egnpiYearData,
    cobList,
  ] = await Promise.all([
    needRisk ? api.getLargeLosses(contractId, qm).catch(() => emptyLossBundle) : Promise.resolve(emptyLossBundle),
    needCat  ? api.getCatLosses(contractId, qm).catch(() => emptyLossBundle)   : Promise.resolve(emptyLossBundle),
    needRisk ? api.getLossSelectionLatest(contractId, 'large', qm).catch(() => emptySelection) : Promise.resolve(emptySelection),
    needCat  ? api.getLossSelectionLatest(contractId, 'cat', qm).catch(() => emptySelection)   : Promise.resolve(emptySelection),
    needCat  ? api.getCrestaData(contractId, qm).catch(() => [])                     : Promise.resolve([]),
    api.getNpEgnpiYear(contractId, qm).catch(() => []),
    // Reference list so we can resolve layer class-of-business UUIDs
    // against the name/code stored on each loss row.
    api.listClassOfBusiness().catch(() => []),
  ]);

  const largeLosses    = largeLossData?.losses || (Array.isArray(largeLossData) ? largeLossData : []);
  const catLosses      = catLossData?.losses   || (Array.isArray(catLossData)   ? catLossData   : []);
  const llSavedParams  = llSnap?.snapshot  || /** @type {LossSelectionSnapshot} */ ({});
  const catSavedParams = catSnap?.snapshot || /** @type {LossSelectionSnapshot} */ ({});
  const crestaRows     = Array.isArray(crestaData)
    ? /** @type {Array<Record<string, unknown>>} */ (crestaData)
    : (/** @type {{ rows?: Array<Record<string, unknown>> }} */ (crestaData)?.rows || []);

  // Build id → token map once per pricing run so every layer can
  // cheap-filter its losses without re-walking the COB catalog.
  const cobIdToTokens = buildCobTokenMap(cobList);

  // Resolve each loss's free-text class_of_business → a COB id at load, so routing
  // is id-based (loss tables store only the text name today). A loss already
  // carrying a native id keeps it; an unresolved name falls back to token matching
  // inside filterLossesForLayer. _cobId is an internal tag the engine ignores.
  const cobNameToId = buildCobNameToId(cobList);
  /** @param {LossLike} l @returns {LossLike} */
  const tagLossCob = (l) => {
    if (!l) return l;
    const native = String(l.cob_id ?? l.class_of_business_id ?? '').trim();
    if (native) return l;
    const id = cobNameToId.get(normCob(l.class_of_business ?? l.classOfBusiness));
    return id ? { ...l, _cobId: id } : l;
  };
  const largeLossesTagged = largeLosses.map(tagLossCob);
  const catLossesTagged   = catLosses.map(tagLossCob);
  // "Were any losses loaded for this scope?" — drives the legitimate-zero vs
  // not-calculated distinction downstream (covered class with 0 losses → 0%,
  // not blank). Counts SELECTED losses (the ones that would contribute).
  const largeLossCount = largeLossesTagged.filter((l) => l && l.is_selected !== false).length;
  const catLossCount   = catLossesTagged.filter((l) => l && l.is_selected !== false).length;

  // Build per-year EGNPI map { year(number) -> egnpi(number) } for Clark-aligned burn cost
  const egnpiRows = Array.isArray(egnpiYearData)
    ? egnpiYearData
    : (/** @type {{ rows?: import('../types/pricing').EgnpiYearRow[] }} */ (egnpiYearData)?.rows || []);
  const egnpiByYear = /** @type {Record<number, number>} */ ({});
  for (const r of egnpiRows) {
    const y = Number(r.uw_year ?? r.uwYear);
    const v = cn(r.egnpi);
    if (y > 0 && v > 0) egnpiByYear[y] = v;
  }

  const obsYearsRisk = cn(llSavedParams.observation_years)
    || Math.max(5, new Set(largeLossesTagged.map(l => l.uw_year)).size) || 10;
  const obsYearsCat  = cn(catSavedParams.observation_years)
    || Math.max(5, new Set(catLossesTagged.map(l => l.uw_year)).size) || 10;

  // Risk profiles for MBBEFD exposure rating
  // NP treaties store COBs at the layer level (contract_np_layer_class_of_business),
  // NOT at the contract level — so getContractCobs returns [] for NP.
  // Collect unique COB IDs from the layers themselves.
  const allCobIds = needRisk
    ? [...new Set(
        layers.flatMap(l =>
          Array.isArray(l.classOfBusinessIds) ? l.classOfBusinessIds
          : Array.isArray(l.class_of_business_ids) ? l.class_of_business_ids
          : []
        ).map(String).filter(Boolean)
      )]
    : [];


  const riskProfileMap = /** @type {Record<string, RiskProfileInput>} */ ({}); // cobId -> { profile, bands }
  if (needRisk && allCobIds.length) {
    const profileResults = await Promise.all(
      allCobIds.map(cobId =>
        api.getRiskProfile(contractId, cobId, qm)
          .then(r => ({ cobId, profile: r?.profile || {}, bands: r?.bands || [] }))
          .catch(() => null)
      )
    );
    for (const r of profileResults) {
      if (r) riskProfileMap[r.cobId] = { profile: r.profile, bands: r.bands };
    }
  }

  // For layers with no COBs defined, fall back to fetching all contract-level COBs
  // (covers prop-style treaties or missing layer-COB linkage)
  /** @type {RiskProfileInput[]} */
  let fallbackProfiles = [];
  if (needRisk && allCobIds.length === 0) {
    try {
      const cobsRes = await api.getContractCobs(contractId, qm).catch(() => []);
      const cobRows = Array.isArray(cobsRes)
        ? cobsRes
        : (/** @type {{ rows?: import('../types/pricing').CobLinkRow[] }} */ (cobsRes)?.rows || []);
      const cobIdList = cobRows
        .map(x => String(x.cob_id || x.id || x.class_of_business_id))
        .filter(Boolean);
      fallbackProfiles = await Promise.all(
        cobIdList.map(cobId =>
          api.getRiskProfile(contractId, cobId, qm)
            .then(r => ({ cobId, profile: r?.profile || {}, bands: r?.bands || [] }))
            .catch(() => null)
        )
      ).then(rs => rs.filter(r => r !== null));
    } catch (_) {}
  }

  // ── Price one peril component for a layer ────────────────────────
  /**
   * @param {number} deductible
   * @param {number} limit
   * @param {number} egnpi
   * @param {LossLike[]} losses
   * @param {LossSelectionSnapshot} savedParams
   * @param {(d: number, lim: number, eg: number) => MethodResult} exposureFn
   * @param {number} obsYears
   */
  function priceComponent(deductible, limit, egnpi, losses, savedParams, exposureFn, obsYears) {
    if (limit <= 0 || egnpi <= 0) return null;
    // Pass per-year EGNPI map for Clark-aligned burn cost (year-matched denominator)
    const burnResult   = calcPureBurningCost(losses, deductible, limit, egnpi, obsYears, egnpiByYear);
    const paretoResult = calcParetoROL(losses, deductible, limit, egnpi, savedParams);
    const expResult    = exposureFn(deductible, limit, egnpi);
    const prAttach  = paretoResult.prAttach  || expResult.prAttach  || 0;
    const prExhaust = paretoResult.prExhaust || expResult.prExhaust || 0;
    return {
      pureBurn:      burnResult.rol   > 0 ? fmtRol(burnResult.rol)   : '0.00%',
      pareto:        paretoResult.rol > 0 ? fmtRol(paretoResult.rol) : '0.00%',
      exposureRating:expResult.rol    > 0 ? fmtRol(expResult.rol)    : '0.00%',
      prAttach:  prAttach  > 0 ? (prAttach  * 100).toFixed(2) + '%' : '0.00%',
      prExhaust: prExhaust > 0 ? (prExhaust * 100).toFixed(2) + '%' : '0.00%',
      // All three _*Rol fields are true ROL (annualLoss / limit), not Rate % EPI.
      _pureBurnRol: burnResult.rol,
      _paretoRol:   paretoResult.rol,
      _exposureRol: expResult.rol,
      // Selected losses that ROUTED to this layer's covered class. 0 ⇒ the covered
      // class has no losses → a legitimate 0.00% (not "not calculated"); the caller
      // pairs this with scopeLossCount to show 0% + a note instead of blank.
      coveredLossCount: Array.isArray(losses) ? losses.filter((x) => x && x.is_selected !== false).length : 0,
      // Total selected losses loaded for the scope — set by the caller per layer.
      scopeLossCount: 0,
    };
  }

  return layers.map((l, idx) => {
    const deductible = cn(l.deductible);
    const limit      = cn(l.limit);
    const egnpi      = cn(l.egnpi) || cn(npDetail.estGnpi);

    // Support both field name conventions used across screens:
    //   l.risk / l.cat  (NpFinalPricing screen)
    //   l.riskCover / l.catCover  (NpStructure screen)
    const layerIsRisk = !!(l.riskCover || l.risk);
    const layerIsCat  = !!(l.catCover  || l.cat);

    // For a pure RISK treaty every layer is a risk layer; same for CAT.
    // For BOTH treaties use the per-layer flags; if neither flag is set
    // fall back to running whichever components the treaty mode allows.
    const isRisk = needRisk && (mode === 'RISK' || layerIsRisk || (!layerIsRisk && !layerIsCat));
    const isCat  = needCat  && (mode === 'CAT'  || layerIsCat  || (!layerIsRisk && !layerIsCat));

    // Build risk profiles for this specific layer's COBs
    const layerCobIds = (
      Array.isArray(l.classOfBusinessIds) ? l.classOfBusinessIds
      : Array.isArray(l.class_of_business_ids) ? l.class_of_business_ids
      : []
    ).map(String).filter(Boolean);

    const riskProfiles = layerCobIds.length
      ? layerCobIds.map(id => riskProfileMap[id]).filter(Boolean)
      : fallbackProfiles;

    // Per-layer loss filtering for burn cost + Pareto. A layer that
    // covers only Motor should only burn on Motor losses; similarly
    // its exposure rating only consumes Motor's risk profile (already
    // the case above via `riskProfiles`). When the layer has no COB
    // linkage, filterLossesForLayer returns the full list — preserves
    // the old behaviour on contracts without layer-COB setup.
    const layerLargeLosses = filterLossesForLayer(largeLossesTagged, layerCobIds, cobIdToTokens);
    const layerCatLosses   = filterLossesForLayer(catLossesTagged,   layerCobIds, cobIdToTokens);

    const riskResult = isRisk ? priceComponent(
      deductible, limit, egnpi,
      layerLargeLosses, llSavedParams,
      (d, lim, eg) => calcRiskExposureRating(riskProfiles, d, lim, eg),
      obsYearsRisk,
    ) : null;

    const catResult = isCat ? priceComponent(
      deductible, limit, egnpi,
      layerCatLosses, catSavedParams,
      (d, lim, eg) => calcCatExposureRating(crestaRows, d, lim, eg, catSavedParams, layerCatLosses, obsYearsCat),
      obsYearsCat,
    ) : null;

    // scopeLossCount = total SELECTED losses loaded for the scope (not just this
    // layer's class). coveredLossCount === 0 with scopeLossCount > 0 means "losses
    // exist, but none for this layer's covered class" → 0%, not blank.
    if (riskResult) riskResult.scopeLossCount = largeLossCount;
    if (catResult)  catResult.scopeLossCount  = catLossCount;

    return { idx, risk: riskResult, cat: catResult };
  });
}
