// src/screens/non_proportional/final_pricing/pricingHelpers.js
//
// Pure pricing-math helpers lifted out of NpFinalPricing so the screen
// file can shrink toward render + wiring. Every function here is
// deterministic: same inputs → same output, no React, no DB.
//
// Cover with tests (see pricingHelpers.test.js) — these are business
// logic and silent drift between client and server would be costly.

import { toN } from './formatters.js';

/**
 * Derive the per-layer "line analysis" view — what a written % and
 * signed % translate into in cash terms, plus peril classification
 * for colour coding.
 *
 * Mirrors the shape the table row renderer expects so the caller can
 * map directly over the returned array.
 *
 * @param {Array<object>} layers             Current structure layers.
 * @param {Record<number,string>} written    Per-layer written-line % (keyed by index).
 * @param {Record<number,string>} signed     Per-layer signed-line % (keyed by index).
 * @returns {Array<object>} One derived row per layer.
 */
export function computeLineAnalysis(layers, written, signed) {
  return layers.map((l, i) => {
    const limit  = toN(l.limit);
    const attach = toN(l.deductible ?? l.attachment);
    const rolPct = toN(l.reinsurerPricing) || toN(l.leadPricing);
    const epFromRol = rolPct > 0 && limit > 0 ? limit * rolPct / 100 : 0;
    const epFromLayer = toN(l.earnedPremium) || toN(l.ep);
    const ep100  = epFromRol || epFromLayer;
    // ep100Warning fires when both inputs that drive ep100 are missing —
    // the resulting "100% line earned premium" is 0, which silently
    // zeroes every downstream cash-line calculation. UI cells that read
    // ep100 should render a warning indicator (e.g. an orange dot or
    // tooltip) when this flag is true.
    const ep100Warning = epFromRol === 0 && epFromLayer === 0;

    const wlRaw  = String(written[i] || '').replace(/%/g, '').trim();
    const wlNum  = parseFloat(wlRaw);
    const wlFrac = Number.isFinite(wlNum) ? wlNum / 100 : 0;
    const linePrem  = wlFrac > 0 ? Math.round(ep100 * wlFrac) : 0;
    const lineLimit = wlFrac > 0 ? Math.round(limit * wlFrac) : 0;

    const slRaw  = String(signed[i] || '').replace(/%/g, '').trim();
    const slNum  = parseFloat(slRaw);
    const slFrac = Number.isFinite(slNum) ? slNum / 100 : 0;
    const sLinePrem  = slFrac > 0 ? Math.round(ep100 * slFrac) : 0;
    const sLineLimit = slFrac > 0 ? Math.round(limit * slFrac) : 0;

    const isRisk = !!(l.riskCover || l.risk);
    const isCat  = !!(l.catCover  || l.cat);
    const peril  = isRisk && isCat ? 'BOTH' : isRisk ? 'RISK' : isCat ? 'CAT' : '—';
    // Hardcoded: these are deliberate status/peril colours, not theme tokens.
    const perilColor =
      isRisk && isCat ? '#a78bfa' :
      isRisk          ? '#38bdf8' :
      isCat           ? '#00d4ff' :
                        'rgba(255,255,255,0.3)';

    return {
      layer: l.layer || `L${i + 1}`,
      limit, attach, ep100, ep100Warning, rolPct,
      wlRaw, wlNum, wlFrac, linePrem, lineLimit,
      slRaw, slNum, slFrac, sLinePrem, sLineLimit,
      isRisk, isCat, peril, perilColor,
    };
  });
}

/**
 * Technical Ratio = 100 − historicalMargin% − brokerage% − taxes%.
 *
 * Returns 0 when historicalMargin is not yet computed — Tech Ratio
 * has no meaning without a margin to subtract from. This guard
 * matches the legacy behaviour at NpFinalPricing.jsx:813/922/1052,
 * which all checked `histM` truthy before computing.
 *
 * Inputs are ALL in percentage-point space (e.g. 70 for 70%, not 0.70).
 */
export function calcTechRatio(historicalMarginPct, brokeragePct, taxesPct) {
  const h = Number(historicalMarginPct) || 0;
  if (!h) return 0;
  const b = Number(brokeragePct) || 0;
  const t = Number(taxesPct) || 0;
  return 100 - h - b - t;
}
