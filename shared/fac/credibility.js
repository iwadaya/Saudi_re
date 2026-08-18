// shared/fac/credibility.js
//
// How much to believe a risk's own loss history.
//
// Bühlmann–Straub, in the form every reinsurance pricing note states it:
//
//     Z = n / (n + k)
//
// where n is the volume of the risk's own experience — claim count for a
// per-risk layer — and k is the volume at which its experience deserves
// half the weight. A large k means "this class is volatile, lean on the
// portfolio"; a small k means "this account is credible on its own".
//
// The blended loss cost is then the usual credibility-weighted average:
//
//     LossCost = Z × Experience + (1 − Z) × Exposure
//
// Two practical constraints on top of the formula, both of which are
// standard and both of which matter more than the formula:
//
//   • Z is capped per family. Layer experience on an excess casualty
//     placement is rarely credible however many claims there are, because
//     the ones that matter have not developed yet; property attritional
//     experience can carry most of the weight. The cap is a family
//     property, not a global constant.
//
//   • The mechanical weight can be overridden, but only with a reason
//     code. An underwriter who has looked at the claims and concluded the
//     history is unrepresentative is usually right, and the point of
//     recording the reason is that the next person can see the judgement
//     rather than an unexplained number.

import { num, numOrNull } from './num.js';

/** Where a family says nothing: half weight at 8 claims, capped at 75%. */
export const DEFAULT_CREDIBILITY = { k: 8, maxZ: 0.75, unit: 'CLAIM_COUNT' };

/** Overrides have to name themselves from this list. */
export const OVERRIDE_REASONS = {
  EXPERIENCE_UNREPRESENTATIVE: 'Experience unrepresentative of the risk going forward',
  STRUCTURE_CHANGED:           'Cover or structure has materially changed',
  EXPOSURE_CHANGED:            'Exposure has materially changed',
  DATA_QUALITY:                'Loss data incomplete or unreliable',
  LARGE_LOSS_DISTORTION:       'A single large loss distorts the period',
  UNDERWRITER_JUDGEMENT:       'Underwriter judgement — see note',
};


/**
 * Bühlmann–Straub credibility factor.
 *
 * @param {number} n        experience volume (claim count, or exposure units)
 * @param {object} [params] {k, maxZ}
 * @returns {{z: number, k: number, maxZ: number, capped: boolean, n: number}}
 */
export function credibilityFactor(n, params = {}) {
  const k = num(params.k ?? DEFAULT_CREDIBILITY.k);
  const maxZ = Math.min(Math.max(num(params.maxZ ?? DEFAULT_CREDIBILITY.maxZ), 0), 1);
  const volume = Math.max(num(n), 0);
  if (k <= 0) return { z: maxZ, k, maxZ, capped: true, n: volume };
  const raw = volume / (volume + k);
  return { z: Math.min(raw, maxZ), k, maxZ, capped: raw > maxZ, n: volume };
}

/**
 * Mechanical weights across the loss-cost candidates.
 *
 * The experience method takes Z; the complement goes to the exposure side,
 * split evenly between whichever exposure-basis methods are available. A
 * method that reported itself unavailable takes no weight at all — it is
 * not zero-weighted data, it is absent, and averaging in a zero would
 * quietly halve the price.
 *
 * @param {Array<{code: string, available: boolean, ratePm: number|null, role: 'EXPERIENCE'|'EXPOSURE'|'REFERENCE'}>} candidates
 * @param {object} [credibility] {k, maxZ}
 * @param {number} [experienceVolume] claim count from the experience method
 * @returns {{weights: Record<string, number>, z: number|null, detail: object}}
 */
export function mechanicalWeights(candidates, credibility, experienceVolume) {
  const usable = (candidates || []).filter(
    (c) => c.available && c.role !== 'REFERENCE' && numOrNull(c.ratePm) !== null,
  );
  const experience = usable.filter((c) => c.role === 'EXPERIENCE');
  const exposure = usable.filter((c) => c.role === 'EXPOSURE');
  const weights = {};

  if (experience.length === 0 && exposure.length === 0) {
    return { weights, z: null, detail: { reason: 'No usable loss-cost method.' } };
  }
  if (experience.length === 0) {
    for (const c of exposure) weights[c.code] = 1 / exposure.length;
    return { weights, z: 0, detail: { reason: 'No experience — exposure carries the whole weight.' } };
  }
  if (exposure.length === 0) {
    // Nothing to blend against. Experience takes the lot even where its own
    // credibility is low, because the alternative is no price at all — but
    // the low Z is reported so the thinness is visible.
    const { z, ...rest } = credibilityFactor(experienceVolume, credibility);
    for (const c of experience) weights[c.code] = 1 / experience.length;
    return {
      weights, z,
      detail: { ...rest, reason: 'No exposure-basis method available — experience carries the whole weight.' },
    };
  }

  const cred = credibilityFactor(experienceVolume, credibility);
  for (const c of experience) weights[c.code] = cred.z / experience.length;
  for (const c of exposure) weights[c.code] = (1 - cred.z) / exposure.length;
  return { weights, z: cred.z, detail: cred };
}

/**
 * Apply an override on top of the mechanical weights.
 *
 * Overrides are normalised to sum to 1 over the candidates they name, so a
 * partial override cannot silently change the total. An override without a
 * recognised reason code is refused — that is the whole control.
 *
 * @param {Record<string, number>} mechanical
 * @param {{weights?: Record<string, number>, reasonCode?: string}|null} override
 * @returns {{weights: Record<string, number>, source: 'MECHANICAL'|'OVERRIDE', reasonCode?: string, error?: string}}
 */
export function applyWeightOverride(mechanical, override) {
  if (!override || !override.weights || Object.keys(override.weights).length === 0) {
    return { weights: mechanical, source: 'MECHANICAL' };
  }
  if (!override.reasonCode || !OVERRIDE_REASONS[override.reasonCode]) {
    return {
      weights: mechanical,
      source: 'MECHANICAL',
      error: 'Weight override ignored — it needs a reason code from the approved list: '
        + `${Object.keys(OVERRIDE_REASONS).join(', ')}.`,
    };
  }
  const entries = Object.entries(override.weights)
    .map(([code, w]) => [code, Math.max(num(w), 0)])
    .filter(([, w]) => w > 0);
  const total = entries.reduce((acc, [, w]) => acc + w, 0);
  if (total <= 0) {
    return { weights: mechanical, source: 'MECHANICAL', error: 'Weight override ignored — the weights sum to zero.' };
  }
  const weights = {};
  for (const [code, w] of entries) weights[code] = w / total;
  return { weights, source: 'OVERRIDE', reasonCode: override.reasonCode };
}

/**
 * Weighted blend of the candidate rates.
 *
 * @param {Array<{code: string, ratePm: number|null}>} candidates
 * @param {Record<string, number>} weights
 * @returns {number|null}
 */
export function blendRates(candidates, weights) {
  let total = 0;
  let acc = 0;
  for (const c of candidates || []) {
    const w = num(weights?.[c.code]);
    // numOrNull, not Number: a null rate must not add its weight to the
    // denominator while contributing nothing to the numerator, which would
    // silently drag the blended rate toward zero.
    const rate = numOrNull(c.ratePm);
    if (w <= 0 || rate === null) continue;
    acc += rate * w;
    total += w;
  }
  return total > 0 ? acc / total : null;
}

/**
 * Sample standard deviation of the annual layer loss.
 *
 * Real dispersion from the risk's own years, which is what a θ×σ risk load
 * should be loaded on. Needs at least three years to mean anything; below
 * that the caller falls back to a percentage load rather than pretending.
 *
 * @param {Array<{layer_loss: number}>} annualSeries
 * @returns {{sigma: number, mean: number, years: number}|null}
 */
export function annualLossVolatility(annualSeries) {
  const values = (annualSeries || []).map((r) => num(r.layer_loss));
  const n = values.length;
  if (n < 3) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  return { sigma: Math.sqrt(variance), mean, years: n };
}
