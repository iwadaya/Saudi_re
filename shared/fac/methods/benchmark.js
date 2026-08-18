// shared/fac/methods/benchmark.js
//
// What the book actually charged for risks like this one.
//
// fac_market_rate has existed since the module was built and has never
// influenced a price: it was seeded by a CROSS JOIN of arbitrary
// multipliers, exposed through a lookup endpoint no screen calls, and read
// by no pricing code, while the market rate that drives the underwriting
// score was typed in by hand (finding F14). This replaces that with the
// only benchmark a carrier can actually stand behind — the rates it has
// bound itself.
//
// The benchmark is a REFERENCE method. It is shown beside the priced
// methods and never carries weight in the blend, for two reasons: it is a
// record of what was charged rather than an estimate of what the losses
// will be, and blending it in would let the book's own history quietly
// anchor its future pricing. An underwriter comparing against it is doing
// something useful; an engine averaging it in is compounding drift.
//
// Small samples are reported, not hidden — with the count attached, so a
// median of three is visibly a median of three.

import { numOrNull } from '../num.js';

export const METHOD_CODE = 'BENCHMARK';

/** Below this many bound comparables the median is indicative at best. */
export const MIN_CONFIDENT_OBSERVATIONS = 5;

/**
 * Percentile of a sorted numeric array, interpolating between neighbours.
 *
 * @param {number[]} sorted
 * @param {number} p 0..1
 * @returns {number|null}
 */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * The BENCHMARK reference candidate.
 *
 * @param {object} args
 * @param {Array<{rate_pm: number|string, uw_year?: number}>} args.observations
 *   bound comparables, already scoped to the family / class / region / size band
 * @param {string} [args.scope] human-readable description of that scoping
 * @returns {{available: boolean, unavailableReason?: string, ratePm?: number,
 *            diagnostics: object}}
 */
export function benchmarkLossCost({ observations, scope }) {
  const rates = (observations || [])
    .map((o) => numOrNull(o.rate_pm))
    .filter((r) => r !== null && r > 0)
    .sort((a, b) => a - b);

  if (rates.length === 0) {
    return {
      available: false,
      unavailableReason: 'No bound comparables yet for this class, region and size band. '
        + 'The benchmark builds itself as business is bound.',
      diagnostics: { n: 0, scope: scope || null },
    };
  }

  const median = percentile(rates, 0.5);
  const confidence = rates.length >= 20 ? 'HIGH'
    : rates.length >= MIN_CONFIDENT_OBSERVATIONS ? 'MEDIUM'
      : 'LOW';

  const warnings = [];
  if (confidence === 'LOW') {
    warnings.push(
      `Benchmark is drawn from only ${rates.length} bound risk${rates.length === 1 ? '' : 's'} — `
      + 'indicative, not a market rate.',
    );
  }

  const years = (observations || []).map((o) => numOrNull(o.uw_year)).filter((y) => y !== null);

  return {
    available: true,
    ratePm: median,
    diagnostics: {
      n: rates.length,
      scope: scope || null,
      confidence,
      p25: percentile(rates, 0.25),
      p50: median,
      p75: percentile(rates, 0.75),
      min: rates[0],
      max: rates[rates.length - 1],
      uw_years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      warnings,
    },
  };
}

/**
 * Where the risk's own rate sits in the benchmark distribution — the line an
 * underwriter reads before a renewal conversation.
 *
 * @param {number|null} ratePm
 * @param {object|null} diagnostics  from benchmarkLossCost
 * @returns {{position: 'BELOW_P25'|'P25_P50'|'P50_P75'|'ABOVE_P75', ratio: number}|null}
 */
export function benchmarkPosition(ratePm, diagnostics) {
  const r = numOrNull(ratePm);
  if (r === null || !diagnostics || diagnostics.n === 0) return null;
  const { p25, p50, p75 } = diagnostics;
  const position = r < p25 ? 'BELOW_P25'
    : r < p50 ? 'P25_P50'
      : r < p75 ? 'P50_P75'
        : 'ABOVE_P75';
  return { position, ratio: p50 > 0 ? r / p50 : null };
}
