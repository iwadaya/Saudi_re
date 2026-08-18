// shared/fac/methods/burningCost.js
//
// Experience rating: what this risk's own history says the cover costs.
//
// fac_loss_history has always collected FGU paid and outstanding by year.
// None of it reached a price — the pricing screen carried a free-text
// `burning_cost_ratio` an underwriter typed in by hand (finding F4). This
// module turns the history into a rate, through the four adjustments that
// separate a burning cost from a sum of old claims:
//
//   1. Index    — trend each loss from its year to current values, so a
//                 2019 claim is compared with a 2026 exposure on equal
//                 terms. Claims inflation, not general inflation.
//   2. Develop  — gross up claims still open, because an open claim is an
//                 estimate and estimates on open claims run low.
//   3. As-if    — restate onto the structure being quoted. A loss under a
//                 lower deductible would not have cost the same under this
//                 one, and only the part landing in the layer counts.
//   4. On-level — divide by what was actually on risk each year, including
//                 the years with no losses at all. Dropping zero-loss years
//                 is the single most common way a burning cost comes out
//                 too high.
//
// Every step is overridable per loss (the columns migration 135 adds), and
// whatever the underwriter overrides is what gets used — the derived chain
// is a default, not an opinion the tool insists on.

import { computeOnLevelFactors } from '../../onLevel.js';

export const METHOD_CODE = 'BURNING_COST';

/** Open claims are grossed up by this much when nothing better is known. */
export const DEFAULT_DEVELOPMENT_FACTOR = 1.15;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Restate one historic loss onto today's values and today's structure.
 *
 * @param {object} loss
 * @param {object} opts
 * @param {number} opts.asOfYear
 * @param {number} opts.trend            annual claims inflation, as a fraction
 * @param {number} opts.developmentFactor default for open claims
 * @param {number} opts.attachment
 * @param {number} opts.limit
 * @returns {{included: boolean, reason?: string, incurred: number, indexed: number,
 *            developed: number, asIf: number, layer: number, years: number}}
 */
export function restateLoss(loss, { asOfYear, trend, developmentFactor, attachment, limit }) {
  const year = numOrNull(loss.loss_year);
  const incurred = num(loss.fgu_incurred ?? (num(loss.fgu_paid) + num(loss.fgu_outstanding)));

  if (loss.exclude_from_rating) {
    return {
      included: false,
      reason: loss.exclusion_reason || 'Excluded from rating',
      incurred, indexed: 0, developed: 0, asIf: 0, layer: 0, years: 0,
    };
  }
  if (year == null) {
    return { included: false, reason: 'No loss year', incurred, indexed: 0, developed: 0, asIf: 0, layer: 0, years: 0 };
  }
  if (incurred <= 0) {
    return { included: false, reason: 'Nil incurred', incurred, indexed: 0, developed: 0, asIf: 0, layer: 0, years: 0 };
  }

  // 1. Index. An explicit indexed_incurred wins — an underwriter who has
  //    restated a claim knows something the trend factor does not.
  const years = Math.max(asOfYear - year, 0);
  const explicitIndexed = numOrNull(loss.indexed_incurred);
  const indexed = explicitIndexed ?? incurred * (1 + trend) ** years;

  // 2. Develop, open claims only.
  const isOpen = loss.is_open !== false;
  const ldf = numOrNull(loss.development_factor) ?? (isOpen ? developmentFactor : 1);
  const developed = indexed * (isOpen ? ldf : 1);

  // 3. As-if. Again, an explicit restatement wins outright.
  const asIf = numOrNull(loss.as_if_incurred) ?? developed;

  // 4. Apply the structure being quoted.
  const d = Math.max(num(attachment), 0);
  const cap = Number.isFinite(limit) ? Math.max(num(limit), 0) : Infinity;
  const layer = Math.min(Math.max(asIf - d, 0), cap);

  return { included: true, incurred, indexed, developed, asIf, layer, years, ldf: isOpen ? ldf : 1 };
}

/**
 * The BURNING_COST loss-cost candidate.
 *
 * @param {object} args
 * @param {Array<object>} args.losses    fac_loss_history rows
 * @param {Array<object>} args.basis     fac_experience_basis rows (the denominator)
 * @param {number} [args.severityTrendPct]  annual claims inflation, whole percent
 * @param {number} [args.asOfYear]
 * @param {number} [args.attachment]
 * @param {number} [args.limit]
 * @param {number} [args.developmentFactor]
 * @param {number} [args.fallbackExposure]  current exposure, used only when no
 *                                          per-year basis has been entered
 * @param {number} [args.fallbackYears]
 * @returns {{available: boolean, unavailableReason?: string, lossCost?: number,
 *            ratePm?: number, claimCount?: number, years?: number, diagnostics: object}}
 */
export function burningCostLossCost({
  losses, basis, severityTrendPct, asOfYear,
  attachment = 0, limit = Infinity,
  developmentFactor = DEFAULT_DEVELOPMENT_FACTOR,
  fallbackExposure, fallbackYears,
}) {
  const warnings = [];
  const trend = num(severityTrendPct) / 100;
  const year = asOfYear || new Date().getUTCFullYear();
  const rows = Array.isArray(losses) ? losses : [];
  const basisRows = (Array.isArray(basis) ? basis : []).filter((b) => numOrNull(b.loss_year) != null);

  // ── Denominator ────────────────────────────────────────────────────
  // Exposure years come from the basis, never from the losses: a year with
  // no claims is exactly the year a burning cost most needs to count.
  let exposureYears = basisRows.length;
  let exposureSum = basisRows.reduce((acc, b) => acc + num(b.exposure_base), 0);
  let denominatorSource = 'EXPERIENCE_BASIS';

  if (exposureYears === 0 || exposureSum <= 0) {
    const fe = num(fallbackExposure);
    const fy = Math.max(Math.trunc(num(fallbackYears)), 0);
    if (fe > 0 && fy > 0) {
      exposureYears = fy;
      exposureSum = fe * fy;
      denominatorSource = 'CURRENT_EXPOSURE';
      warnings.push(
        `No per-year exposure recorded — using today's exposure across ${fy} year(s) as the `
        + 'denominator. Enter the historic sums insured on Loss Experience for a defensible burn rate.',
      );
    } else {
      return {
        available: false,
        unavailableReason: 'No exposure years recorded. Burning cost needs what was on risk each '
          + 'year, including the years with no losses — enter it on Loss Experience.',
        diagnostics: { lossCount: rows.length, warnings },
      };
    }
  }

  // ── Numerator ──────────────────────────────────────────────────────
  const restated = rows.map((l) => ({ loss: l, r: restateLoss(l, { asOfYear: year, trend, developmentFactor, attachment, limit }) }));
  const included = restated.filter((x) => x.r.included);
  const hitting = included.filter((x) => x.r.layer > 0);
  const layerTotal = included.reduce((acc, x) => acc + x.r.layer, 0);

  if (included.length === 0) {
    warnings.push('No usable losses in the period — the burn rate is nil, which is a result, not an absence of one.');
  }

  // Per-year layer losses — the denominator years included, at nil. The
  // spread of these is what a standard-deviation risk load is loaded on,
  // so a year with no claims has to appear as a zero, not be absent.
  const byYear = new Map(basisRows.map((b) => [Number(b.loss_year), 0]));
  for (const { loss, r } of included) {
    const y = Number(loss.loss_year);
    if (byYear.has(y)) byYear.set(y, byYear.get(y) + r.layer);
    else byYear.set(y, r.layer);
  }
  const annualSeries = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, v]) => ({ year: y, layer_loss: v }));

  const annualLoss = layerTotal / exposureYears;
  const avgExposure = exposureSum / exposureYears;
  const ratePm = avgExposure > 0 ? (annualLoss / avgExposure) * 1000 : null;

  // On-levelled loss ratio, when premiums were recorded. Not the rate the
  // engine uses — a cross-check an underwriter recognises.
  let lossRatio = null;
  const withPremium = basisRows.filter((b) => num(b.premium) > 0);
  if (withPremium.length > 0) {
    const years = withPremium.map((b) => Number(b.loss_year));
    const rateByYear = Object.fromEntries(withPremium.map((b) => [Number(b.loss_year), num(b.rate_change_pct)]));
    const factors = computeOnLevelFactors(years, rateByYear);
    const onLevelled = withPremium.reduce(
      (acc, b) => acc + num(b.premium) * (factors.get(Number(b.loss_year)) ?? 1), 0,
    );
    if (onLevelled > 0) lossRatio = layerTotal / onLevelled;
  }

  return {
    available: true,
    lossCost: annualLoss,
    ratePm,
    claimCount: hitting.length,
    years: exposureYears,
    diagnostics: {
      denominator_source: denominatorSource,
      exposure_years: exposureYears,
      average_exposure: avgExposure,
      severity_trend_pct: num(severityTrendPct),
      development_factor: developmentFactor,
      attachment: num(attachment),
      limit: Number.isFinite(limit) ? num(limit) : null,
      total_incurred: included.reduce((acc, x) => acc + x.r.incurred, 0),
      total_as_if: included.reduce((acc, x) => acc + x.r.asIf, 0),
      total_in_layer: layerTotal,
      annual_layer_losses: annualSeries,
      claims_in_layer: hitting.length,
      claims_excluded: restated.length - included.length,
      on_levelled_loss_ratio: lossRatio,
      warnings,
    },
  };
}
