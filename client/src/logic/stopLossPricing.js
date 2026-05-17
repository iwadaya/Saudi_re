// client/src/logic/stopLossPricing.js
//
// Pure-JS pricing engine for Stop Loss and Aggregate XL covers — both
// are layer covers attached to the AGGREGATE annual loss S, not to
// individual claims. The only difference is the attachment basis:
//
//   - Stop Loss     → attaches at a loss ratio of subject premium
//                     (e.g. "80% LR xs 100% LR")
//   - Aggregate XL  → attaches at an absolute aggregate amount
//                     (e.g. "$5M xs $10M aggregate")
//
// Both feed through the same math; `priceStopLoss` accepts attachment
// and limit in either form (LR% + EPI → absolute) and dispatches.
//
// Three pricing methods, blended with weights mirroring
// `deriveComponentTotal` in shared/pricingMath.js:
//
//   1. Burning Cost     — historical aggregate losses by UW year,
//                         layer applied, annualised across the full
//                         observation window (zero-loss years included).
//   2. Exposure Rating  — Poisson(λ) frequency × Lognormal/Pareto
//                         severity; aggregate moments computed in
//                         closed form, layer cost via Normal
//                         approximation to the aggregate.
//   3. Monte Carlo      — same compound-Poisson model, but simulated.
//                         Returns the full empirical distribution
//                         (mean, CV, percentiles) — the right choice
//                         when the tail matters (heavy-tailed severity,
//                         high-attaching layer) and the Normal approx
//                         under-prices it.
//
// No React, no network. Caller passes inputs, engine returns numbers.

import {
  layerHit,
  annualiseLoss,
  rolFromAnnualLoss,
  applyLoading,
  clamp,
  attachmentFromLossRatio,
  lognormalFromMeanCv,
  lognormalMoments,
  paretoMoments,
  compoundPoissonMoments,
  normalLayerMean,
} from '../../../shared/pricingMath.js';

// ────────────────────────────────────────────────────────────────────────────
// Random-number generation. Deterministic mulberry32 so that
// reruns with the same seed are bit-identical — important for
// reproducibility of Monte Carlo pricing across user sessions.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mulberry32 — small, fast, statistically adequate PRNG. Returns a
 * function that yields uniform [0, 1) samples.
 *
 * @param {number} seed  32-bit integer seed.
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard-normal sample via Box-Muller. Uses two uniforms per call
 * but returns only one normal — we don't bother caching the second.
 *
 * @param {() => number} rand
 * @returns {number}
 */
function sampleStandardNormal(rand) {
  // u1 must be strictly > 0 (else log diverges); rand() can return 0,
  // so re-draw on the (negligibly rare) zero case.
  let u1 = rand();
  while (u1 === 0) u1 = rand();
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Lognormal sample with underlying-normal parameters (μ, σ).
 *
 * @param {() => number} rand
 * @param {number} mu
 * @param {number} sigma
 * @returns {number}
 */
function sampleLognormal(rand, mu, sigma) {
  if (sigma <= 0) return Math.exp(mu);
  return Math.exp(mu + sigma * sampleStandardNormal(rand));
}

/**
 * Single-parameter Pareto sample via inverse CDF.
 *   F(x) = 1 - (θ/x)^α   ⇒   X = θ · U^(-1/α)
 *
 * @param {() => number} rand
 * @param {number} alpha
 * @param {number} theta
 * @returns {number}
 */
function samplePareto(rand, alpha, theta) {
  let u = rand();
  while (u === 0) u = rand();
  return theta * Math.pow(u, -1 / alpha);
}

/**
 * Poisson sample. Knuth's product method for λ < 30 (exact); for
 * larger λ we use Atkinson's PA method via the rejection on a normal
 * proposal — accurate and O(1) per draw.
 *
 * @param {() => number} rand
 * @param {number} lambda
 * @returns {number}
 */
function samplePoisson(rand, lambda) {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    while (true) {
      k += 1;
      p *= rand();
      if (p <= L) return k - 1;
    }
  }
  // Normal approximation with continuity correction for large λ.
  // The bias on E[S] is exact (mean preserved); only the third+
  // moments differ slightly from a true Poisson — fine at this scale.
  const z = sampleStandardNormal(rand);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

// ────────────────────────────────────────────────────────────────────────────
// Severity helpers — translate UI inputs into moments / samplers.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SeverityInput
 * @property {'lognormal'|'pareto'} type
 * @property {number} [mean]   Lognormal: E[X] in currency.
 * @property {number} [cv]     Lognormal: σ_X / mean.
 * @property {number} [alpha]  Pareto: shape parameter (α > 0).
 * @property {number} [theta]  Pareto: scale / minimum loss (θ > 0).
 */

/**
 * Resolve a severity input to {mean, secondMoment, draw(rand)}.
 * Returns null with a warning if inputs are invalid for the
 * declared distribution.
 *
 * @param {SeverityInput} severity
 * @param {string[]} warnings
 * @returns {{mean: number, secondMoment: number, draw: (r:()=>number)=>number}|null}
 */
function resolveSeverity(severity, warnings) {
  if (!severity || typeof severity !== 'object') {
    warnings.push('Severity input missing — exposure rating and Monte Carlo will be skipped.');
    return null;
  }
  if (severity.type === 'lognormal') {
    const params = lognormalFromMeanCv(severity.mean, severity.cv);
    if (!params) {
      warnings.push(`Lognormal severity needs mean > 0 and CV ≥ 0 (got mean=${severity.mean}, cv=${severity.cv}).`);
      return null;
    }
    const moments = lognormalMoments(params.mu, params.sigma);
    return {
      mean: moments.mean,
      secondMoment: moments.secondMoment,
      draw: (r) => sampleLognormal(r, params.mu, params.sigma),
    };
  }
  if (severity.type === 'pareto') {
    const { alpha, theta } = severity;
    if (!(alpha > 0) || !(theta > 0)) {
      warnings.push(`Pareto severity needs α > 0 and θ > 0 (got α=${alpha}, θ=${theta}).`);
      return null;
    }
    const moments = paretoMoments(alpha, theta);
    if (!Number.isFinite(moments.mean)) {
      warnings.push(`Pareto α=${alpha} ≤ 1 → infinite mean; exposure rating cannot price this with a Normal approximation. Use Monte Carlo or a heavier capped severity.`);
    }
    return {
      mean: moments.mean,
      secondMoment: moments.secondMoment,
      draw: (r) => samplePareto(r, alpha, theta),
    };
  }
  warnings.push(`Unknown severity type "${severity?.type}" — expected "lognormal" or "pareto".`);
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Method 1: Burning Cost on the aggregate annual loss.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BurningCostResult
 * @property {number} annualLoss     Expected layer loss per year.
 * @property {number} rol            annualLoss / limit.
 * @property {{year: number|string, aggregate: number, inLayer: number}[]} byYear
 * @property {number} nYears         Observation window (= byYear.length).
 */

/**
 * Burning Cost on the aggregate. Caller passes one entry per
 * observation year — INCLUDING zero-loss years, since the long-run
 * frequency denominator is the full window (see annualiseLoss docs).
 *
 * @param {Object} args
 * @param {{year: number|string, aggregate: number}[]} args.yearlyAggregates
 * @param {number} args.attachment   D — priority on the aggregate.
 * @param {number} args.limit        L — layer width.
 * @returns {BurningCostResult}
 */
export function burningCostStopLoss({ yearlyAggregates, attachment, limit }) {
  const rows = Array.isArray(yearlyAggregates) ? yearlyAggregates : [];
  const byYear = rows.map((r) => {
    const aggregate = Number(r?.aggregate);
    const safeAgg = Number.isFinite(aggregate) ? aggregate : 0;
    return {
      year: r?.year ?? null,
      aggregate: safeAgg,
      inLayer: layerHit(safeAgg, attachment, limit),
    };
  });
  const totalInLayer = byYear.reduce((s, r) => s + r.inLayer, 0);
  const nYears = byYear.length;
  const annualLoss = annualiseLoss(totalInLayer, nYears);
  return {
    annualLoss,
    rol: rolFromAnnualLoss(annualLoss, limit),
    byYear,
    nYears,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Method 2: Exposure Rating (compound Poisson + Normal approximation).
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExposureRatingResult
 * @property {number} annualLoss
 * @property {number} rol
 * @property {number} aggMean
 * @property {number} aggStd
 * @property {boolean} normalApproxValid  False when severity has
 *   infinite second moment (heavy-tailed Pareto with α ≤ 2).
 */

/**
 * Exposure rating via the Normal approximation to the compound Poisson
 * aggregate. Accurate when the aggregate is dominated by claim
 * frequency rather than the severity tail (Berry-Esseen kicks in at
 * λ·E[X²]/E[X]² ≫ 1). Falls apart for heavy-tailed severity or low-
 * frequency-high-severity portfolios — use Monte Carlo there.
 *
 * @param {Object} args
 * @param {{lambda: number}} args.frequency
 * @param {SeverityInput} args.severity
 * @param {number} args.attachment
 * @param {number} args.limit
 * @param {string[]} [args.warnings]
 * @returns {ExposureRatingResult|null}
 */
export function exposureRatingStopLoss({ frequency, severity, attachment, limit, warnings = [] }) {
  const lambda = Number(frequency?.lambda);
  if (!Number.isFinite(lambda) || lambda < 0) {
    warnings.push(`Frequency λ must be ≥ 0 (got ${frequency?.lambda}).`);
    return null;
  }
  const sev = resolveSeverity(severity, warnings);
  if (!sev) return null;
  const agg = compoundPoissonMoments(lambda, sev.mean, sev.secondMoment);
  const normalApproxValid = Number.isFinite(agg.std);
  if (!normalApproxValid) {
    warnings.push('Aggregate variance is infinite — Normal approximation invalid; rely on Monte Carlo instead.');
  }
  const annualLoss = normalApproxValid ? normalLayerMean(agg.mean, agg.std, attachment, limit) : 0;
  return {
    annualLoss,
    rol: rolFromAnnualLoss(annualLoss, limit),
    aggMean: agg.mean,
    aggStd: agg.std,
    normalApproxValid,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Method 3: Monte Carlo aggregate simulation.
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MonteCarloResult
 * @property {number} annualLoss
 * @property {number} rol
 * @property {number} cv               σ(layerHit) / E[layerHit].
 * @property {number} hitFrequency     Pr(layerHit > 0).
 * @property {{p50: number, p75: number, p90: number, p95: number, p99: number}} percentiles
 * @property {number} aggMean          Sample mean of S (for sanity).
 * @property {number} nTrials
 */

/**
 * Monte Carlo aggregate simulation. For each trial year: draw N ~
 * Poisson(λ); sum N iid severity draws to get S; apply the layer.
 * The returned mean is the layer cost; the percentiles describe the
 * full layer-loss distribution — useful for capital and PML reporting.
 *
 * @param {Object} args
 * @param {{lambda: number}} args.frequency
 * @param {SeverityInput} args.severity
 * @param {number} args.attachment
 * @param {number} args.limit
 * @param {number} [args.nTrials=10000]
 * @param {number} [args.seed=1]
 * @param {string[]} [args.warnings]
 * @returns {MonteCarloResult|null}
 */
export function monteCarloStopLoss({ frequency, severity, attachment, limit, nTrials = 10_000, seed = 1, warnings = [] }) {
  const lambda = Number(frequency?.lambda);
  if (!Number.isFinite(lambda) || lambda < 0) {
    warnings.push(`Frequency λ must be ≥ 0 (got ${frequency?.lambda}).`);
    return null;
  }
  const sev = resolveSeverity(severity, warnings);
  if (!sev) return null;
  const N = Math.max(100, Math.floor(Number(nTrials) || 0));
  const rand = mulberry32(seed);
  const layerLosses = new Float64Array(N);
  const aggregates = new Float64Array(N);
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const claimCount = samplePoisson(rand, lambda);
    let agg = 0;
    for (let j = 0; j < claimCount; j++) agg += sev.draw(rand);
    aggregates[i] = agg;
    const hit = layerHit(agg, attachment, limit);
    layerLosses[i] = hit;
    if (hit > 0) hits += 1;
  }
  const mean = layerLosses.reduce((s, v) => s + v, 0) / N;
  let sq = 0;
  for (let i = 0; i < N; i++) {
    const d = layerLosses[i] - mean;
    sq += d * d;
  }
  const sd = Math.sqrt(sq / N);
  const sortedLayer = Array.from(layerLosses).sort((a, b) => a - b);
  const q = (p) => sortedLayer[Math.min(N - 1, Math.max(0, Math.floor(p * N)))];
  const aggMean = aggregates.reduce((s, v) => s + v, 0) / N;
  return {
    annualLoss: mean,
    rol: rolFromAnnualLoss(mean, limit),
    cv: mean > 0 ? sd / mean : 0,
    hitFrequency: hits / N,
    percentiles: {
      p50: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      p95: q(0.95),
      p99: q(0.99),
    },
    aggMean,
    nTrials: N,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator: priceStopLoss.
// ────────────────────────────────────────────────────────────────────────────

function resolveAttachmentAndLimit(args, warnings) {
  // Absolute form (Aggregate XL) takes precedence; loss-ratio form
  // (Stop Loss treaties) is the fallback and requires EPI.
  let { attachment, limit } = args;
  const epi = Number(args.epi);
  if (!Number.isFinite(attachment)) {
    if (Number.isFinite(args.attachmentLossRatio) && epi > 0) {
      attachment = attachmentFromLossRatio(args.attachmentLossRatio, epi);
    } else {
      warnings.push('Attachment missing — provide either absolute "attachment" or "attachmentLossRatio" + "epi".');
      attachment = 0;
    }
  }
  if (!Number.isFinite(limit)) {
    if (Number.isFinite(args.limitLossRatio) && epi > 0) {
      limit = attachmentFromLossRatio(args.limitLossRatio, epi);
    } else {
      warnings.push('Limit missing — provide either absolute "limit" or "limitLossRatio" + "epi".');
      limit = 0;
    }
  }
  return { attachment: Math.max(0, attachment), limit: Math.max(0, limit) };
}

/**
 * @typedef {Object} StopLossPricingResult
 * @property {number} attachment
 * @property {number} limit
 * @property {BurningCostResult|null}   burningCost
 * @property {ExposureRatingResult|null} exposureRating
 * @property {MonteCarloResult|null}     monteCarlo
 * @property {{annualLoss: number, rol: number, totalRate: number}} blended
 * @property {string[]} warnings
 */

/**
 * Single entry point for the Stop Loss / Aggregate XL UI.
 *
 * @param {Object} args
 * @param {number} [args.attachment]            Absolute attachment.
 * @param {number} [args.limit]                 Absolute limit.
 * @param {number} [args.attachmentLossRatio]   Stop Loss form: % of EPI.
 * @param {number} [args.limitLossRatio]        Stop Loss form: % of EPI.
 * @param {number} [args.epi]                   Required when LR inputs used.
 * @param {{year, aggregate}[]} [args.yearlyAggregates]  Burning cost input.
 * @param {{lambda: number}}    [args.frequency]         Exposure / MC input.
 * @param {SeverityInput}       [args.severity]          Exposure / MC input.
 * @param {{burningCost?: number, exposureRating?: number, monteCarlo?: number}} [args.weights]
 *   Method weights (default: 100% burning cost when historical data is
 *   present, else 100% exposure). Pass at most one with non-zero value
 *   to "pick" a single method; weights are normalised by their sum.
 * @param {boolean} [args.useMonteCarlo=false]  Toggle: compute MC and
 *   blend it in (otherwise MC is null and its weight is ignored).
 * @param {{nTrials?: number, seed?: number}} [args.monteCarlo]
 * @param {number} [args.loading=0]            % loading (0..99).
 * @returns {StopLossPricingResult}
 */
export function priceStopLoss(args) {
  const warnings = [];
  const { attachment, limit } = resolveAttachmentAndLimit(args, warnings);

  const burningCost = Array.isArray(args.yearlyAggregates) && args.yearlyAggregates.length > 0
    ? burningCostStopLoss({ yearlyAggregates: args.yearlyAggregates, attachment, limit })
    : null;

  const canExposure = args.frequency && args.severity;
  const exposureRating = canExposure
    ? exposureRatingStopLoss({ frequency: args.frequency, severity: args.severity, attachment, limit, warnings })
    : null;

  const useMC = !!args.useMonteCarlo;
  const monteCarlo = useMC && canExposure
    ? monteCarloStopLoss({
        frequency: args.frequency,
        severity: args.severity,
        attachment,
        limit,
        nTrials: args.monteCarlo?.nTrials,
        seed: args.monteCarlo?.seed,
        warnings,
      })
    : null;

  // Default weights: 100% on whichever single method has output.
  const defaultWeights = {
    burningCost: burningCost ? 1 : 0,
    exposureRating: !burningCost && exposureRating ? 1 : 0,
    monteCarlo: 0,
  };
  const requested = args.weights || defaultWeights;
  const wB = burningCost ? clamp(Number(requested.burningCost) || 0, 0, 100) : 0;
  const wE = exposureRating ? clamp(Number(requested.exposureRating) || 0, 0, 100) : 0;
  const wM = monteCarlo ? clamp(Number(requested.monteCarlo) || 0, 0, 100) : 0;
  const wTot = wB + wE + wM;

  let blendedLoss = 0;
  if (wTot > 0) {
    blendedLoss =
      (wB * (burningCost?.annualLoss ?? 0) +
        wE * (exposureRating?.annualLoss ?? 0) +
        wM * (monteCarlo?.annualLoss ?? 0)) /
      wTot;
  } else if (burningCost) {
    blendedLoss = burningCost.annualLoss;
  } else if (exposureRating) {
    blendedLoss = exposureRating.annualLoss;
  } else if (monteCarlo) {
    blendedLoss = monteCarlo.annualLoss;
  } else {
    warnings.push('No pricing method produced output — supply yearlyAggregates or frequency+severity.');
  }

  const rol = rolFromAnnualLoss(blendedLoss, limit);
  const loadingPct = clamp(Number(args.loading) || 0, 0, 99);
  const totalRate = applyLoading(rol, loadingPct);

  return {
    attachment,
    limit,
    burningCost,
    exposureRating,
    monteCarlo,
    blended: { annualLoss: blendedLoss, rol, totalRate },
    warnings,
  };
}
