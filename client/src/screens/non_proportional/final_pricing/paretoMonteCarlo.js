/**
 * paretoMonteCarlo.js
 * ─────────────────────────────────────────────────────────────────
 * Pure, deterministic, seeded Monte-Carlo aggregate-loss engine for a
 * single excess-of-loss layer.
 *
 * Design rules:
 *   • Framework-free and synchronous — no React, no DOM, no API. The
 *     paretoMonteCarlo.worker.js wrapper runs it off the main thread, but
 *     the engine itself is plain functions so it can be unit-tested.
 *   • Reuses the severity primitives already in npPricingEngine.js
 *     (fitPareto, paretoQ, paretoLEV) rather than duplicating them; the
 *     GPD / lognormal / frequency machinery missing there is added here.
 *   • Seeded throughout (mulberry32). Identical inputs ⇒ identical output,
 *     so there is no flicker between runs and an audit can reproduce a
 *     reported number exactly.
 *
 * The caller supplies losses that are ALREADY trended + developed, the
 * fit threshold, the severity family, the frequency assumption and the
 * layer terms; the engine fits severity (with bootstrap CI bands), then
 * simulates `nSims` annual aggregate losses through the layer.
 */

import { invNormalCdf as invNormCdf, normalCdf as normCdf } from '../../../../../shared/pricingMath.js';
import { toN } from '../../../utils/format.js';
import { fitPareto, paretoQ, paretoLEV } from '../../../utils/npPricingEngine.js';

// ── Seeded RNG ─────────────────────────────────────────────────────
/**
 * mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Returns a
 * generator of U[0,1) values. Everything downstream draws from one of
 * these so the whole run is a pure function of the seed.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw from a generator but keep the value strictly inside (0,1) so the
 * inverse-CDF transforms (paretoQ, invNormCdf, …) never see 0 or 1. */
const u01 = (rng) => {
  const u = rng();
  return u > 0 && u < 1 ? u : (u <= 0 ? 1e-12 : 1 - 1e-12);
};

// ── Normal distribution helpers ────────────────────────────────────
/**
 * Inverse standard-normal CDF (Acklam's rational approximation,
 * |abs error| < 1.15e-9). Used for lognormal sampling and Gaussian
 * draws inside the Gamma sampler.
 * @param {number} p
 * @returns {number}
 */
// Both come from shared/pricingMath.js (the single implementation); kept as
// named re-exports because the simulation tests exercise them directly.
export { invNormCdf, normCdf };

/** One standard-normal draw from a generator. */
const stdNormal = (rng) => invNormCdf(u01(rng));

// ── Small stats helpers ────────────────────────────────────────────
const meanOf = (arr) => {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
};
const sdOf = (arr, mean) => {
  if (arr.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) { const d = arr[i] - mean; s += d * d; }
  return Math.sqrt(s / (arr.length - 1));
};
/** p-quantile of an ascending-sorted array (linear interpolation). */
function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[n - 1];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
/** Tail VaR at level p: mean of the worst (1−p) fraction of an ascending array. */
function tvarSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  let k = Math.ceil(p * n);
  if (k >= n) k = n - 1;
  if (k < 0) k = 0;
  let s = 0;
  for (let i = k; i < n; i++) s += sorted[i];
  return s / (n - k);
}

// ── Severity: fitting ──────────────────────────────────────────────
/**
 * Generalized Pareto (excess) fit by Probability-Weighted Moments
 * (Hosking & Wallis 1987) — more stable than MLE on the small samples
 * typical of large-loss tails. Returns the standard EVT parameters
 * (ξ, σ) for S(y) = (1 + ξ y/σ)^(−1/ξ), y ≥ 0.
 * @param {number[]} excesses  losses minus threshold (≥ 0)
 * @returns {{ xi: number, sigma: number }}
 */
export function fitGpdPwm(excesses) {
  const n = excesses.length;
  if (n < 2) return { xi: 0, sigma: meanOf(excesses) };
  const sorted = [...excesses].sort((p, q) => p - q);
  // a0 = E[X], a1 = E[X(1−F)] estimated with the unbiased plotting weights.
  let a0 = 0;
  let a1 = 0;
  for (let j = 0; j < n; j++) {
    a0 += sorted[j];
    a1 += ((n - 1 - j) / (n - 1)) * sorted[j];
  }
  a0 /= n;
  a1 /= n;
  const denom = a0 - 2 * a1;
  if (Math.abs(denom) < 1e-12 || !(a0 > 0)) return { xi: 0, sigma: a0 };
  const k = a0 / denom - 2;          // Hosking's k = −ξ
  const sigma = (2 * a0 * a1) / denom;
  return { xi: -k, sigma: sigma > 0 ? sigma : a0 };
}

/** Lognormal fit: μ, σ of the logs of the (positive) sample. */
function fitLognormal(values) {
  const logs = values.filter((v) => v > 0).map(Math.log);
  const mu = meanOf(logs);
  return { mu, sigma: sdOf(logs, mu) };
}

/** Fit one severity family to a sample at a fixed threshold. */
function fitFamily(family, sample, threshold) {
  if (family === 'PARETO') {
    const { alpha } = fitPareto(sample, threshold);
    return { alpha, xm: threshold };
  }
  if (family === 'LOGNORMAL') return fitLognormal(sample);
  const excesses = sample.map((x) => x - threshold).filter((y) => y >= 0);
  return fitGpdPwm(excesses);
}

const PARAM_KEYS = { PARETO: ['alpha'], LOGNORMAL: ['mu', 'sigma'], GPD: ['xi', 'sigma'] };

/**
 * Fit the chosen severity family to losses ≥ threshold and bootstrap the
 * fit B times for CI bands (and for per-trial estimation-risk resampling).
 * Deterministic: all bootstrap resampling comes from the supplied rng.
 */
function fitSeverity(family, losses, threshold, B, rng, warnings) {
  const tail = losses.filter((x) => x >= threshold && x > 0);
  const n = tail.length;
  const minPts = family === 'LOGNORMAL' ? 2 : 3;
  if (n < minPts) warnings.push(`severity: ${n} loss(es) ≥ threshold (need ${minPts}+) — fit may be unreliable`);

  const params = fitFamily(family, tail, threshold);
  const keys = PARAM_KEYS[family] || PARAM_KEYS.GPD;
  /** @type {Record<string, number[]>} */
  const bootstrap = {};
  for (const key of keys) bootstrap[key] = [];

  const reps = n > 0 ? B : 0;
  for (let b = 0; b < reps; b++) {
    const resample = new Array(n);
    for (let i = 0; i < n; i++) resample[i] = tail[Math.floor(u01(rng) * n)];
    const f = fitFamily(family, resample, threshold);
    for (const key of keys) bootstrap[key].push(f[key]);
  }

  /** @type {Record<string, [number, number]>} */
  const ci = {};
  for (const key of keys) {
    if (!bootstrap[key].length) { ci[key] = [params[key], params[key]]; continue; }
    const s = [...bootstrap[key]].sort((p, q) => p - q);
    ci[key] = [quantileSorted(s, 0.025), quantileSorted(s, 0.975)];
  }
  return { family, threshold, n, params, ci, bootstrap, bootstrapCount: reps, keys };
}

/** Pick one bootstrap parameter set (estimation-risk draw). xm/threshold stays fixed. */
function drawBootstrapParams(fit, rng) {
  if (!fit.bootstrapCount) return fit.params;
  const j = Math.min(fit.bootstrapCount - 1, Math.floor(u01(rng) * fit.bootstrapCount));
  const out = { ...fit.params };
  for (const key of fit.keys) out[key] = fit.bootstrap[key][j];
  return out;
}

// ── Severity: sampling + analytic layer mean ───────────────────────
/** GPD loss quantile (full value, incl. threshold): x = u + (σ/ξ)((1−p)^(−ξ)−1). */
function gpdQuantile(p, xi, sigma, threshold) {
  if (!(sigma > 0)) return threshold;
  const s = 1 - p;
  if (Math.abs(xi) < 1e-8) return threshold - sigma * Math.log(s);
  return threshold + (sigma / xi) * (Math.pow(s, -xi) - 1);
}

/**
 * Severity quantile at probability p for the fitted family (full loss value,
 * incl. threshold). Also the inverse-transform sampler — pass a U[0,1) draw.
 */
export function severityQuantile(family, params, threshold, p) {
  if (family === 'PARETO') return paretoQ(p, params.alpha, params.xm);
  if (family === 'LOGNORMAL') return Math.exp(params.mu + params.sigma * invNormCdf(p));
  return gpdQuantile(p, params.xi, params.sigma, threshold);
}

/** Survival S(x) = P(X > x) for the fitted family (1 below threshold/support). */
export function severitySurvival(family, params, threshold, x) {
  if (!(x > 0)) return 1;
  if (family === 'PARETO') {
    const { alpha, xm } = params;
    if (!(alpha > 0) || !(xm > 0) || x <= xm) return 1;
    return Math.pow(xm / x, alpha);
  }
  if (family === 'LOGNORMAL') {
    if (!(params.sigma > 0)) return x >= Math.exp(params.mu) ? 0 : 1;
    return 1 - normCdf((Math.log(x) - params.mu) / params.sigma);
  }
  const y = x - threshold;                       // GPD excess
  if (y <= 0) return 1;
  const { xi, sigma } = params;
  if (!(sigma > 0)) return 1;
  if (Math.abs(xi) < 1e-8) return Math.exp(-y / sigma);
  const base = 1 + (xi * y) / sigma;
  return base <= 0 ? 0 : Math.pow(base, -1 / xi);
}

/** E[min(X,c)] for a lognormal(μ,σ). */
function lognormalLEV(mu, sigma, c) {
  if (c <= 0) return 0;
  if (!(sigma > 0)) return Math.min(Math.exp(mu), c);
  const lnc = Math.log(c);
  const d1 = (lnc - mu - sigma * sigma) / sigma;
  const d2 = (lnc - mu) / sigma;
  return Math.exp(mu + (sigma * sigma) / 2) * normCdf(d1) + c * (1 - normCdf(d2));
}

/** GPD expected layer cost per loss: ∫_a^b S(y) dy, a/b excess endpoints. */
function gpdLayerMean(xi, sigma, a, b) {
  if (sigma <= 0 || b <= a) return 0;
  if (xi < 0) {
    const yMax = -sigma / xi;                 // GPD with ξ<0 has finite support
    if (a >= yMax) return 0;
    b = Math.min(b, yMax);
  }
  if (Math.abs(xi) < 1e-8) return sigma * (Math.exp(-a / sigma) - Math.exp(-b / sigma));
  if (Math.abs(xi - 1) < 1e-8) return sigma * Math.log((1 + b / sigma) / (1 + a / sigma));
  const G = (y) => (sigma / (xi - 1)) * Math.pow(1 + (xi * y) / sigma, (xi - 1) / xi);
  return G(b) - G(a);
}

/** Analytic E[ceded per loss] = E[min(max(X−A,0), L)] for the fitted family. */
export function severityLayerMean(family, params, threshold, attachment, limit) {
  if (limit <= 0) return 0;
  if (family === 'PARETO') {
    const { alpha, xm } = params;
    if (!(alpha > 0) || !(xm > 0)) return 0;
    // No clamp of the attachment up to xm: the simulation cedes from the
    // TRUE attachment (every sampled X ≥ xm pierces a lower attachment in
    // full), and paretoLEV(c) = c for c ≤ xm, so the unclamped LEV
    // difference matches the simulated mean exactly. The old
    // D = max(attachment, xm) clamp made the analytic-vs-MC reconciliation
    // gate (|z| ≤ 4) fail for layers attaching below the fit threshold.
    return paretoLEV(alpha, xm, attachment + limit) - paretoLEV(alpha, xm, attachment);
  }
  if (family === 'LOGNORMAL') {
    return lognormalLEV(params.mu, params.sigma, attachment + limit) - lognormalLEV(params.mu, params.sigma, attachment);
  }
  return gpdLayerMean(params.xi, params.sigma, Math.max(attachment - threshold, 0), Math.max(attachment + limit - threshold, 0));
}

// ── Frequency: counts ──────────────────────────────────────────────
/** Poisson(λ): Knuth for small λ, Gaussian approximation for large λ. */
function samplePoisson(rng, lambda) {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k += 1; p *= u01(rng); } while (p > L);
    return k - 1;
  }
  const n = Math.round(lambda + Math.sqrt(lambda) * stdNormal(rng));
  return n > 0 ? n : 0;
}

/** Gamma(shape, scale) via Marsaglia & Tsang (2000). */
function sampleGamma(rng, shape, scale) {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1) return sampleGamma(rng, shape + 1, scale) * Math.pow(u01(rng), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do { x = stdNormal(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = u01(rng);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/**
 * Draw a claim count. NEGBIN is a Gamma-Poisson mixture parameterised by
 * `dispersion` d so Var(N) = λ + d·λ² (d = 0 ⇒ Poisson) — large-loss
 * counts are over-dispersed, so this is the realistic default for cat.
 */
function sampleFrequency(rng, freq, lambda) {
  if (freq.type === 'NEGBIN' && freq.dispersion > 0 && lambda > 0) {
    const r = 1 / freq.dispersion;
    const theta = lambda * freq.dispersion;
    return samplePoisson(rng, sampleGamma(rng, r, theta));
  }
  return samplePoisson(rng, lambda);
}

/** Resample λ from its sampling distribution (estimation risk on frequency). */
function resampleLambda(rng, freq) {
  if (freq.years > 0) return samplePoisson(rng, freq.lambda * freq.years) / freq.years;
  return Math.max(0, freq.lambda + Math.sqrt(Math.max(freq.lambda, 0)) * stdNormal(rng));
}

// ── Output builders ────────────────────────────────────────────────
function buildHistogram(sorted, bins) {
  const n = sorted.length;
  const max = n ? sorted[n - 1] : 0;
  if (!(max > 0)) return { binWidth: 0, min: 0, max, bins: [{ x0: 0, x1: 0, count: n, density: 0 }] };
  const width = max / bins;
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    let bi = Math.floor(sorted[i] / width);
    if (bi >= bins) bi = bins - 1;
    if (bi < 0) bi = 0;
    counts[bi] += 1;
  }
  return {
    binWidth: width,
    min: 0,
    max,
    bins: counts.map((c, i) => ({ x0: i * width, x1: (i + 1) * width, count: c, density: c / (n * width) })),
  };
}

function buildEcdf(sorted, points = 100) {
  const out = [];
  for (let k = 0; k <= points; k++) {
    const p = k / points;
    out.push({ x: quantileSorted(sorted, p), p });
  }
  return out;
}

// ── Main engine ────────────────────────────────────────────────────
/**
 * @typedef {Object} MonteCarloParams
 * @property {number} [seed]                 PRNG seed (default 12345)
 * @property {number} [nSims]                trials (default 10000)
 * @property {number} [bootstrap]            severity bootstrap reps (default 500)
 * @property {number} [histogramBins]        output histogram bins (default 50)
 * @property {boolean} [resampleParams]      redraw params per trial (default false)
 * @property {number[]} losses               trended+developed losses
 * @property {number} threshold              fit threshold (xm / GPD u)
 * @property {{ family?: string }} [severity] 'GPD'|'PARETO'|'LOGNORMAL'
 * @property {{ type?: string, lambda?: number, dispersion?: number, years?: number }} [frequency]
 * @property {{ attachment?: number, limit?: number, reinstatements?: number|string, reinstPct?: number, premium?: number }} layer
 */

/**
 * Run the seeded Monte-Carlo aggregate-loss simulation for one layer.
 * @param {MonteCarloParams} params
 * @returns {object} results (see fields assembled below)
 */
export function runParetoMonteCarlo(params = /** @type {any} */ ({})) {
  const seed = Number.isFinite(params.seed) ? (Number(params.seed) >>> 0) : 12345;
  const nSims = Math.max(1, Math.floor(toN(params.nSims) || 10000));
  const bootstrapB = Math.max(0, Math.floor(params.bootstrap == null ? 500 : toN(params.bootstrap)));
  const histogramBins = Math.max(1, Math.floor(toN(params.histogramBins) || 50));
  const family = String(params.severity?.family || 'GPD').toUpperCase();
  const resampleParams = !!params.resampleParams;

  const threshold = toN(params.threshold);
  const losses = (Array.isArray(params.losses) ? params.losses : []).map(toN).filter((x) => x > 0);

  const layer = params.layer || {};
  const attachment = toN(layer.attachment);
  const limit = toN(layer.limit);
  const unlimited = String(layer.reinstatements ?? '').trim().toUpperCase() === 'UNLIMITED';
  const numReinst = unlimited ? Infinity : Math.max(0, toN(layer.reinstatements));
  const reinstPct = layer.reinstPct == null ? 1 : toN(layer.reinstPct);
  const layerPremium = toN(layer.premium);
  const aggLimit = unlimited ? Infinity : limit * (1 + numReinst);

  const warnings = [];

  // Two deterministic streams, both fixed by `seed`: one for the fit /
  // bootstrap, one for the simulation. Separating them keeps the
  // simulation draws independent of the bootstrap size.
  const fitRng = mulberry32((seed + 0x9e3779b9) >>> 0);
  const simRng = mulberry32(seed);

  let fit = fitSeverity(family, losses, threshold, bootstrapB, fitRng, warnings);

  // Optional caller override of the fitted point params (underwriter edits in
  // the UI, or params restored from a saved quote). When present they REPLACE
  // the data fit's point estimate — so the sim reproduces exactly from stored
  // params + seed even if the underlying losses later change. The bootstrap
  // arrays (estimation risk) still come from the data.
  const override = params.severity?.params;
  if (override && typeof override === 'object') {
    const merged = { ...fit.params };
    let any = false;
    for (const key of (PARAM_KEYS[family] || PARAM_KEYS.GPD)) {
      const v = toN(override[key]);
      if (override[key] != null && override[key] !== '' && Number.isFinite(v)) { merged[key] = v; any = true; }
    }
    if (family === 'PARETO') merged.xm = threshold;
    if (any) fit = { ...fit, params: merged };
  }

  const freq = {
    type: String(params.frequency?.type || 'POISSON').toUpperCase(),
    lambda: Math.max(0, toN(params.frequency?.lambda)),
    dispersion: Math.max(0, toN(params.frequency?.dispersion)),
    years: Math.max(0, toN(params.frequency?.years)),
  };

  const agg = new Float64Array(nSims);        // capped aggregate ceded per trial
  let sumUncapped = 0;
  let sumUncappedSq = 0;
  let sumReinstUsed = 0;
  let sumReinstPrem = 0;
  let nAttach = 0;
  let nExhaust = 0;

  for (let t = 0; t < nSims; t++) {
    // Estimation-risk toggle: redraw severity params + λ ONCE per trial.
    const sevParams = resampleParams ? drawBootstrapParams(fit, simRng) : fit.params;
    const lambdaT = resampleParams ? resampleLambda(simRng, freq) : freq.lambda;

    const count = sampleFrequency(simRng, freq, lambdaT);
    let aggCeded = 0;
    for (let i = 0; i < count; i++) {
      const loss = severityQuantile(family, sevParams, threshold, u01(simRng));
      aggCeded += Math.min(Math.max(loss - attachment, 0), limit);
    }
    const capped = unlimited ? aggCeded : Math.min(aggCeded, aggLimit);
    const reinstUsed = limit > 0 ? Math.max(0, capped / limit - 1) : 0;
    // Reinstatement premium on the standard pro-rata-capita basis
    // (Sundt / Mata): premium is charged on the amount of cover REINSTATED,
    // min(S, n·L) / L per unit of layer premium × reinstatement %. The old
    // reinstUsed basis max(0, S/L − 1) charged only on consumption of the
    // second-and-later limits, understating E[Reinst Prem] ~4.8× (a year
    // ceding exactly one full limit pays a full reinstatement premium, not
    // zero). reinstUsed is kept unchanged as the "reinstatements used" count.
    const reinstCover = limit > 0 ? Math.min(capped, numReinst * limit) / limit : 0;

    agg[t] = capped;
    sumUncapped += aggCeded;
    sumUncappedSq += aggCeded * aggCeded;
    sumReinstUsed += reinstUsed;
    sumReinstPrem += reinstCover * layerPremium * reinstPct;
    if (aggCeded > 0) nAttach += 1;
    if (!unlimited && aggCeded >= aggLimit) nExhaust += 1;
  }

  const sorted = Float64Array.prototype.slice.call(agg).sort();   // numeric ascending
  const mean = meanOf(agg);
  const sd = sdOf(agg, mean);

  const levels = [0.5, 0.9, 0.98, 0.99, 0.995];
  const returnPeriods = [2, 10, 50, 100, 200];
  const tail = levels.map((p, k) => ({
    rp: returnPeriods[k],
    level: p,
    var: quantileSorted(sorted, p),
    tvar: tvarSorted(sorted, p),
  }));

  const meanUncapped = sumUncapped / nSims;
  const varUncapped = Math.max(0, sumUncappedSq / nSims - meanUncapped * meanUncapped);
  const mcStandardError = Math.sqrt(varUncapped / nSims);
  const analyticPerLoss = severityLayerMean(family, fit.params, threshold, attachment, limit);
  const analyticExpectedLoss = freq.lambda * analyticPerLoss;
  const zScore = mcStandardError > 0 ? (meanUncapped - analyticExpectedLoss) / mcStandardError : 0;

  return {
    seed,
    nSims,
    family,
    threshold,
    resampleParams,
    severity: { family, threshold, n: fit.n, params: fit.params, ci: fit.ci, bootstrap: fit.bootstrapCount },
    frequency: { type: freq.type, lambda: freq.lambda, dispersion: freq.dispersion, years: freq.years, meanCount: freq.lambda },
    layer: {
      attachment,
      limit,
      reinstatements: unlimited ? 'UNLIMITED' : numReinst,
      reinstPct,
      premium: layerPremium,
      aggLimit: unlimited ? null : aggLimit,
    },
    aggregate: {
      mean,                                       // pure premium (capped)
      sd,
      cov: mean > 0 ? sd / mean : 0,
      meanUncapped,
      percentiles: { p50: tail[0].var, p90: tail[1].var, p98: tail[2].var, p99: tail[3].var, p995: tail[4].var },
      tail,                                       // VaR + TVaR at 1-in-{2,10,50,100,200}
      pAttach: nAttach / nSims,                   // P(agg > 0)
      pExhaust: nExhaust / nSims,                 // P(agg ≥ aggLimit)
      eReinstUsed: sumReinstUsed / nSims,
      eReinstPremium: sumReinstPrem / nSims,
      histogram: buildHistogram(sorted, histogramBins),
      ecdf: buildEcdf(sorted),
    },
    reconciliation: {
      // Analytic E[layer loss] from paretoLEV (Pareto) / closed-form LEV
      // (GPD, lognormal). Compared against the UNCAPPED simulated mean so
      // the reinstatement cap doesn't bias the gate. |z| ≤ 4 ⇒ the MC
      // mean matches analytic within Monte-Carlo standard error.
      analyticExpectedLoss,
      simulatedMean: mean,
      simulatedMeanUncapped: meanUncapped,
      mcStandardError,
      zScore,
      withinTolerance: !(analyticExpectedLoss > 0) || Math.abs(zScore) <= 4,
    },
    warnings,
  };
}

// ── Severity fit + diagnostics (consumed by the SeverityFitPanel UI) ───
/**
 * Fit one severity family to losses ≥ threshold and return the point
 * estimate plus bootstrap CI bands — the lightweight path the UI uses
 * (no simulation). Deterministic in `seed`.
 * @returns {{ family: string, threshold: number, n: number,
 *             params: Record<string,number>, ci: Record<string,[number,number]>,
 *             warnings: string[] }}
 */
export function fitSeverityWithCI(family, values, threshold, opts = {}) {
  const fam = String(family || 'GPD').toUpperCase();
  const B = Math.max(0, Math.floor(opts.bootstrap == null ? 500 : opts.bootstrap));
  const seed = Number.isFinite(opts.seed) ? (Number(opts.seed) >>> 0) : 12345;
  const rng = mulberry32((seed + 0x9e3779b9) >>> 0);
  const warnings = [];
  const losses = (Array.isArray(values) ? values : []).map(toN).filter((x) => x > 0);
  const fit = fitSeverity(fam, losses, toN(threshold), B, rng, warnings);
  return { family: fit.family, threshold: fit.threshold, n: fit.n, params: fit.params, ci: fit.ci, warnings };
}

/**
 * Empirical mean-excess curve e(u) = mean(X − u | X > u) over a grid of
 * thresholds. Used to defend the fit threshold: above a good threshold a
 * heavy (GPD) tail plots roughly linearly. Threshold-independent of the fit.
 * @returns {{ u: number, e: number, n: number }[]}
 */
export function buildMeanExcess(values, points = 40) {
  const data = (values || []).map(toN).filter((x) => x > 0).sort((a, b) => a - b);
  const n = data.length;
  if (n < 3) return [];
  const out = [];
  const maxIdx = Math.max(1, Math.floor(n * 0.9));   // stop at ~90th pct (tail too noisy)
  const step = Math.max(1, Math.floor(maxIdx / points));
  for (let i = 0; i < maxIdx; i += step) {
    const u = data[i];
    let sum = 0;
    let cnt = 0;
    for (let j = i + 1; j < n; j++) { if (data[j] > u) { sum += data[j] - u; cnt += 1; } }
    if (cnt > 0) out.push({ u, e: sum / cnt, n: cnt });
  }
  return out;
}

/**
 * Log-log survival data: empirical survival points for losses ≥ threshold
 * plus the fitted survival curve on a log-spaced grid. A Pareto/GPD tail is
 * a straight line on log-log axes — the eye sees an honest fit.
 * @returns {{ empirical: {x:number,s:number}[], fitted: {x:number,s:number}[] }}
 */
export function buildSurvivalLogLog(values, family, params, threshold, points = 80) {
  const thr = toN(threshold);
  const tail = (values || []).map(toN).filter((x) => x >= thr && x > 0).sort((a, b) => a - b);
  const m = tail.length;
  const empirical = [];
  for (let i = 0; i < m; i++) empirical.push({ x: tail[i], s: (m - i - 0.5) / m });
  const fitted = [];
  const xMax = m ? tail[m - 1] : thr;
  if (xMax > thr && thr > 0) {
    const lo = Math.log(thr);
    const hi = Math.log(xMax);
    for (let k = 0; k <= points; k++) {
      const x = Math.exp(lo + (hi - lo) * (k / points));
      const s = severitySurvival(family, params, thr, x);
      if (s > 0) fitted.push({ x, s });
    }
  }
  return { empirical, fitted };
}

/**
 * Q-Q data: fitted-family theoretical quantiles vs the empirical order
 * statistics of losses ≥ threshold. On a good fit the points hug y = x.
 * (Pareto/GPD quantiles are conditional on ≥ threshold; lognormal is
 * unconditional, so its low-tail points sit below the line — expected.)
 * @returns {{ theoretical: number, empirical: number }[]}
 */
export function buildQQ(values, family, params, threshold) {
  const thr = toN(threshold);
  const tail = (values || []).map(toN).filter((x) => x >= thr && x > 0).sort((a, b) => a - b);
  const m = tail.length;
  const out = [];
  for (let i = 0; i < m; i++) {
    const p = (i + 0.5) / m;
    out.push({ theoretical: severityQuantile(family, params, thr, p), empirical: tail[i] });
  }
  return out;
}

/**
 * Kolmogorov–Smirnov goodness-of-fit: the max gap between the empirical CDF
 * of losses ≥ threshold and the fitted (threshold-conditional) CDF. Smaller
 * is better. Returns NaN for fewer than 2 tail points.
 * @returns {{ d: number, n: number }}
 */
export function ksStatistic(values, family, params, threshold) {
  const thr = toN(threshold);
  const tail = (values || []).map(toN).filter((x) => x >= thr && x > 0).sort((a, b) => a - b);
  const m = tail.length;
  if (m < 2) return { d: NaN, n: m };
  const sThr = severitySurvival(family, params, thr, thr) || 1;   // ~1 for Pareto/GPD
  let d = 0;
  for (let i = 0; i < m; i++) {
    const fFit = 1 - severitySurvival(family, params, thr, tail[i]) / sThr;   // conditional CDF
    d = Math.max(d, Math.abs(fFit - i / m), Math.abs(fFit - (i + 1) / m));
  }
  return { d, n: m };
}

export default runParetoMonteCarlo;
