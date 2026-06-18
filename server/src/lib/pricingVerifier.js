// server/src/lib/pricingVerifier.js
//
// Server-side spot-check for NP pricing outputs. The client computes
// per-layer pure-burn + pareto + exposure + loading → total_price;
// this module re-derives total_price using the canonical shared math
// and flags any row where the stored value diverges from the
// re-computed one beyond a small tolerance.
//
// What we check (per row):
//   1. Weights sum ≈ 100. burn + pareto + exposure should total
//      100 ± TOLERANCE_WEIGHT.
//   2. total_price matches deriveComponentTotal(pure, pareto,
//      exposure, wBurn, wPareto, wExp, loading).
//
// ──────────────────────────────────────────────────────────────────
// Operating modes — when to flip PRICING_STRICT=1
// ──────────────────────────────────────────────────────────────────
//
// Default ("warn-only"):
//   - Drifts are logged at WARN level with the request ID and a
//     summary of the offending fields.
//   - An X-Pricing-Drift-Count header is attached to every response
//     so dashboards / load-test scripts can graph drift rate over
//     time without parsing logs.
//   - The save still completes — drifted rows go to the DB.
//
// Strict (PRICING_STRICT=1, true, or yes):
//   - Same logging + header behaviour.
//   - The save is rejected with 422 PRICING_DRIFT and the drift list
//     is returned to the client so the UI can highlight the offending
//     layers.
//
// When is it safe to flip strict on?
//   1. Run warn-only in production for at least one full pricing
//      cycle (renewal week + a quote week).
//   2. Confirm dashboards show drift count = 0 across that window.
//      Drift > 0 with the same root cause every time means the
//      canonical math has a bug or the tolerance is wrong; fix
//      first, don't enforce.
//   3. Make sure the rollback path is rehearsed — strict can be
//      switched back off via env var without a redeploy by sending
//      SIGHUP after `unset PRICING_STRICT` (or whatever your
//      orchestrator's reload semantics are).
//   4. Communicate to the underwriting team — strict mode means a
//      stale browser tab can fail to save instead of silently
//      drifting.

import { logger } from './logger.js';
import { deriveComponentTotal, parsePricingNumber } from '../../../shared/pricingMath.js';

// Absolute + relative tolerance combined so we're right near zero (where
// relative tolerance is meaningless) AND at large rates.
const TOLERANCE_ABS = 0.0002;  // 2 basis points on a rate scale
const TOLERANCE_REL = 0.002;   // 0.2% of expected

// How far the weights can drift from summing to 100 before we flag.
// 0.5 is generous — client rounds weights to integers in the UI, and
// the stored values can be 40/59 if the user typed 40/60.
const TOLERANCE_WEIGHT = 0.5;

function toN(v) {
  return parsePricingNumber(v);
}

function withinTolerance(actual, expected) {
  const diff = Math.abs(actual - expected);
  if (diff <= TOLERANCE_ABS) return true;
  const rel = Math.abs(expected) > 0 ? diff / Math.abs(expected) : Infinity;
  return rel <= TOLERANCE_REL;
}

/**
 * Verify an array of NP pricing output rows. Returns a list of drift
 * descriptors — empty when everything agrees.
 *
 * @param {Array<object>} outputs
 * @returns {Array<{layer_number:number, section:string, field:string, stored:number, expected:number, absDiff:number}>}
 */
export function verifyNpPricingOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  const drifts = [];

  for (const row of outputs) {
    if (!row || typeof row !== 'object') continue;

    const layerNum = Number(row.layer_number);
    const section  = String(row.section || '');

    const pureBurn = toN(row.pure_burning_cost);
    const pareto   = toN(row.pareto_pricing);
    const exposure = toN(row.exposure_rating);
    const wBurn    = toN(row.burn_weight_pct);
    const wPareto  = toN(row.pareto_weight_pct);
    const wExp     = toN(row.exposure_weight_pct);
    const loading  = toN(row.pricing_loading_pct);
    const storedTotal = toN(row.total_price);

    // Check 1: weights sum to ~100
    const weightSum = wBurn + wPareto + wExp;
    if (Math.abs(weightSum - 100) > TOLERANCE_WEIGHT) {
      drifts.push({
        layer_number: layerNum,
        section,
        field: 'weights_sum',
        stored: weightSum,
        expected: 100,
        absDiff: Math.abs(weightSum - 100),
      });
    }

    // Check 2: total_price matches re-derived value
    const expectedTotal = deriveComponentTotal(pureBurn, pareto, exposure, wBurn, wPareto, wExp, loading);
    if (!withinTolerance(storedTotal, expectedTotal)) {
      drifts.push({
        layer_number: layerNum,
        section,
        field: 'total_price',
        stored: storedTotal,
        expected: expectedTotal,
        absDiff: Math.abs(storedTotal - expectedTotal),
      });
    }
  }

  return drifts;
}

/**
 * Compact human-readable summary of a drift list, suitable for
 * log messages. "3 drifts (2 total_price on L1-L2, 1 weights_sum on L3)".
 */
export function summariseDrifts(drifts) {
  if (!drifts || drifts.length === 0) return 'none';
  const byField = drifts.reduce((acc, d) => {
    acc[d.field] = (acc[d.field] || 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(byField).map(([k, n]) => `${n}×${k}`);
  return `${drifts.length} drift${drifts.length === 1 ? '' : 's'} (${parts.join(', ')})`;
}

export function driftMagnitudeBucket(maxAbsDiff) {
  const n = Number(maxAbsDiff);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 0.001) return '<0.001';
  if (n < 0.01) return '<0.01';
  if (n < 0.1) return '<0.1';
  return '>=0.1';
}

export function pricingDriftStats(drifts) {
  const list = Array.isArray(drifts) ? drifts : [];
  const maxAbsDiff = list.reduce((max, d) => {
    const n = Number(d?.absDiff);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
  return {
    pricingDriftCount: list.length,
    maxAbsDiff,
    driftMagnitudeBucket: driftMagnitudeBucket(maxAbsDiff),
  };
}

/** Env-gated strict mode. When true, drifts become 422s. */
export function isStrictMode() {
  const v = process.env.PRICING_STRICT;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Emit a startup warning when the server is running in production
 * with PRICING_STRICT unset. Warn-only mode is the safe default but
 * silently letting drift slip through in production is precisely the
 * failure mode this verifier exists to prevent — surface it loudly
 * once at boot so it can't be missed.
 *
 * Call from bootstrap.js after validateRuntimeEnv().
 */
export function warnIfWarnOnlyInProduction() {
  if (process.env.NODE_ENV !== 'production') return;
  if (isStrictMode()) return;
  logger.warn(
    'Pricing verifier running in warn-only mode — set PRICING_STRICT=1 to ' +
    'reject saves whose total_price disagrees with the canonical formula. ' +
    'See server/src/lib/pricingVerifier.js for guidance on when to enable.'
  );
}
