// shared/fac/methods/exposureCurve.js
//
// Exposure rating: allocate a ground-up expected loss to a layer using an
// exposure curve.
//
// An exposure curve (first loss scale, first loss distribution) is
//
//     G(x) = the share of the ground-up expected loss that falls at or
//            below a damage ratio x of the maximum possible loss
//
// so the expected loss to a layer L excess of D on a risk with maximum
// possible loss MPL is the difference of the curve at the two attachment
// points, scaled back up:
//
//     E[loss to (D, D+L]] = MPL × [ G(min((D+L)/MPL, 1)) − G(min(D/MPL, 1)) ]
//
// and the credit for a deductible d — the share of the ground-up cost the
// cedant keeps below the deductible, which is what `deductibleCredit` returns
// — is G(min(d/MPL, 1)). The insurer's remaining share above it is the
// complement, 1 − G(min(d/MPL, 1)).
//
// That arithmetic is the definition of the curve and needs no calibration.
// What the CURVE is does: its shape is a view about how severe losses are
// for this kind of risk, and that view is underwriting judgement backed by
// data somebody owns. So curves are reference data here (fac_exposure_curve,
// migration 135), selected per size band, and this module only interpolates
// and applies them.
//
// ── On curve sources (docs/facultative-pricing-design.md §8) ───────────────
// The tool ships exactly one curve as data: G(x) = x, the uniform
// destruction rate. It is the definitional baseline — it asserts nothing
// about severity — and it is deliberately not a market curve.
//
// Published curve families are supported two ways: load them as tabulated
// points, or generate them from MBBEFD parameters with `mbbefdCurve(b, g)`
// below, which implements Bernegger's two-parameter exposure curve exactly
// as published. What this module does NOT do is map a single "curve number"
// onto (b, g) — the one-parameter Swiss Re subfamily. The treaty engine has
// such a mapping (`SWISS_RE_C` in client/src/utils/npPricingEngine.js) and
// it is the subject of an open, unresolved actuarial finding in
// docs/pricing-signoff-required.md. Reproducing an unverified
// parameterisation to save an underwriter a lookup would put an unsourced
// number into a price, so the parameters are supplied, not guessed.
//
// Reference: Bernegger, S. (1997), "The Swiss Re Exposure Curves and the
// MBBEFD Distribution Class", ASTIN Bulletin 27(1), 99–111.

/** Loss-cost method code this module implements. */
export const METHOD_CODE = 'EXPOSURE_CURVE';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Curve evaluation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bernegger's MBBEFD exposure curve, parameterised by b ≥ 0 and g ≥ 1.
 *
 *   G(x) = x                                                  g = 1 or b = 0
 *   G(x) = ln(1 + (g−1)x) / ln(g)                             g > 1, b = 1
 *   G(x) = (1 − b^x) / (1 − b)                                g > 1, bg = 1
 *   G(x) = ln( ((g−1)b + (1−bg)b^x) / (1−b) ) / ln(bg)        otherwise
 *
 * g is the reciprocal of the total-loss probability (p = 1/g); b controls
 * how much of the cost sits in small damage ratios. bg = 1, bg > 1 and
 * bg < 1 give the Maxwell-Boltzmann, Bose-Einstein and Fermi-Dirac cases
 * the distribution class is named for.
 *
 * @param {number} b
 * @param {number} g
 * @returns {(x: number) => number}
 */
export function mbbefdCurve(b, g) {
  const B = num(b);
  const G = num(g);
  if (!(G >= 1) || !(B >= 0)) {
    throw new Error(`MBBEFD needs b ≥ 0 and g ≥ 1; got b=${b}, g=${g}`);
  }
  return (x) => {
    const z = Math.min(Math.max(num(x), 0), 1);
    if (z <= 0) return 0;
    if (z >= 1) return 1;
    if (G === 1 || B === 0) return z;
    if (B === 1) return Math.log(1 + (G - 1) * z) / Math.log(G);
    if (Math.abs(B * G - 1) < 1e-12) return (1 - B ** z) / (1 - B);
    return Math.log(((G - 1) * B + (1 - B * G) * B ** z) / (1 - B)) / Math.log(B * G);
  };
}

/**
 * A tabulated curve, evaluated by linear interpolation between its points.
 *
 * Interpolating linearly keeps the curve monotone as long as the points are
 * — which the y-column check in migration 135 does not enforce on its own,
 * so we sort and clamp here rather than trust the caller. A curve that
 * decreased would produce a negative layer cost, which would look like a
 * discount rather than the bad data it is.
 *
 * @param {Array<{x: number|string, y: number|string}>} points
 * @returns {(x: number) => number}
 */
export function tabulatedCurve(points) {
  const pts = (points || [])
    .map((p) => ({ x: num(p.x), y: num(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) {
    throw new Error('A tabulated exposure curve needs at least two points.');
  }
  // Pin the ends: G(0) = 0 and G(1) = 1 by definition.
  if (pts[0].x > 0) pts.unshift({ x: 0, y: 0 });
  if (pts[pts.length - 1].x < 1) pts.push({ x: 1, y: 1 });

  return (x) => {
    const z = Math.min(Math.max(num(x), 0), 1);
    if (z <= pts[0].x) return pts[0].y;
    const last = pts[pts.length - 1];
    if (z >= last.x) return last.y;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x <= z) lo = mid; else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const span = b.x - a.x;
    if (span <= 0) return a.y;
    return a.y + ((z - a.x) / span) * (b.y - a.y);
  };
}

/**
 * Build an evaluator from a curve reference-data row.
 *
 * @param {{kind?: string, params?: object, points?: Array}} curve
 * @returns {(x: number) => number}
 */
export function curveEvaluator(curve) {
  if (!curve) throw new Error('No exposure curve supplied.');
  if (curve.kind === 'MBBEFD') {
    const { b, g } = curve.params || {};
    return mbbefdCurve(b, g);
  }
  return tabulatedCurve(curve.points);
}

// ────────────────────────────────────────────────────────────────────────────
// Allocation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Expected loss to a layer on one risk, given its ground-up expected loss.
 *
 * @param {object} args
 * @param {number} args.groundUpLoss  expected ground-up loss for this risk
 * @param {number} args.mpl           maximum possible loss (SI × PML%)
 * @param {number} args.attachment    D
 * @param {number} args.limit         L (Infinity for an unlimited top layer)
 * @param {(x: number) => number} args.G
 * @returns {number}
 */
export function layerExpectedLoss({ groundUpLoss, mpl, attachment, limit, G }) {
  const M = num(mpl);
  const gu = num(groundUpLoss);
  if (M <= 0 || gu <= 0) return 0;
  const d = Math.max(num(attachment), 0);
  const top = Number.isFinite(limit) ? d + Math.max(num(limit), 0) : Infinity;
  if (top <= d) return 0;
  const share = G(Math.min(top / M, 1)) - G(Math.min(d / M, 1));
  return gu * Math.max(share, 0);
}

/**
 * The share of the ground-up cost a deductible removes.
 *
 * @param {object} args
 * @param {number} args.mpl
 * @param {number} args.deductible
 * @param {(x: number) => number} args.G
 * @returns {number} 0..1
 */
export function deductibleCredit({ mpl, deductible, G }) {
  const M = num(mpl);
  const d = num(deductible);
  if (M <= 0 || d <= 0) return 0;
  return Math.min(Math.max(G(Math.min(d / M, 1)), 0), 1);
}

/**
 * Price one exposure band: risks of a similar size sharing a curve.
 *
 * The ground-up expected loss for the band comes from a burn rate applied
 * to the band's exposure — exposure rating says how that loss splits across
 * the tower, not how big it is in total.
 *
 * @param {object} band
 * @param {number} band.exposure        sum insured in the band
 * @param {number} band.pmlPct          0..1
 * @param {number} band.groundUpRatePm  ground-up rate ‰ for the band
 * @param {(x: number) => number} band.G
 * @param {number} attachment
 * @param {number} limit
 */
function bandLayerLoss(band, attachment, limit) {
  const exposure = num(band.exposure);
  const pml = Math.min(Math.max(num(band.pmlPct), 0), 1);
  const mpl = exposure * (pml > 0 ? pml : 1);
  const groundUpLoss = (exposure * num(band.groundUpRatePm)) / 1000;
  return layerExpectedLoss({ groundUpLoss, mpl, attachment, limit, G: band.G });
}

/**
 * The EXPOSURE_CURVE loss-cost candidate.
 *
 * Returns an unavailable result rather than throwing when no curve is
 * configured. A carrier that has not loaded a curve set has not made a
 * mistake — it simply cannot exposure-rate yet, and the blend has to be
 * able to say so and carry on with the methods it does have.
 *
 * @param {object} args
 * @param {Array<{exposure, pmlPct, groundUpRatePm, curve}>} args.bands
 * @param {number} args.attachment      0 for a proportional placement
 * @param {number} args.limit           Infinity when the whole risk is exposed
 * @param {number} args.exposureTotal   denominator for the rate ‰
 * @returns {{available: boolean, unavailableReason?: string, lossCost?: number,
 *            ratePm?: number, diagnostics: object}}
 */
export function exposureCurveLossCost({ bands, attachment = 0, limit = Infinity, exposureTotal }) {
  const usable = (bands || []).filter((b) => num(b.exposure) > 0 && b.curve);
  if (usable.length === 0) {
    return {
      available: false,
      unavailableReason: (bands || []).length === 0
        ? 'No exposure bands — enter the sums insured, or a location schedule, first.'
        : 'No exposure curve is configured for this family and size band. '
          + 'Load a curve set before exposure rating.',
      diagnostics: { bandCount: (bands || []).length },
    };
  }

  let lossCost = 0;
  const perBand = [];
  for (const band of usable) {
    const G = curveEvaluator(band.curve);
    const loss = bandLayerLoss({ ...band, G }, attachment, limit);
    lossCost += loss;
    perBand.push({
      exposure: num(band.exposure),
      pml_pct: num(band.pmlPct),
      curve: band.curve.curve_code || band.curve.code || null,
      ground_up_rate_pm: num(band.groundUpRatePm),
      layer_loss: loss,
    });
  }

  const denom = num(exposureTotal) || usable.reduce((acc, b) => acc + num(b.exposure), 0);
  return {
    available: true,
    lossCost,
    ratePm: denom > 0 ? (lossCost / denom) * 1000 : null,
    diagnostics: {
      bands: perBand,
      attachment: num(attachment),
      limit: Number.isFinite(limit) ? num(limit) : null,
      exposure_total: denom,
    },
  };
}
