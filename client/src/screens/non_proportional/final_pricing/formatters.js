// src/screens/non_proportional/final_pricing/formatters.js
// Numeric + pricing-math helpers lifted out of NpFinalPricing.jsx so
// they can be unit-tested in isolation and reused across the
// sub-components that now live alongside it.
//
// These are all pure functions — no React, no DOM, no pricing state.
// Adding a new formatter? Add it here and add a test beside it.

import { formatWithCommas, toN as parseNumber } from '../../../utils/format';

/** Parse any "loose" numeric input (strings with %, commas, etc.) into
 *  a finite number. Returns 0 for anything unparseable — matches the
 *  existing NP screen convention. */
export function toN(v) {
  return parseNumber(v);
}

/** Display a number with thousands separators. */
export function fmtC(v) { return formatWithCommas(v); }

/** Format a finite number as a percentage string. Returns '–' for NaN. */
export function pct(n, d = 2) {
  return Number.isFinite(n) ? `${n.toFixed(d)}%` : '–';
}

/** Compact money display — 1.5M, 250K, plain with commas otherwise. */
export function fmtM(v) {
  const n = toN(v);
  if (!n) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return fmtC(n);
}

/** Money string with a currency prefix, e.g. "USD 1,500,000". */
export function money(v, ccy) {
  const n = toN(v);
  return n ? `${ccy} ${fmtC(Math.round(n))}` : '—';
}

/** Percent with em-dash fallback (user-facing, hides zero). */
export function fmtPctV(v, d = 2) {
  const n = toN(v);
  return n ? `${n.toFixed(d)}%` : '—';
}

// ── Pricing math ────────────────────────────────────────────────────

/**
 * A fresh blank pricing layer at position `i` (0-indexed). The NP
 * screen builds its layer list by pushing these and then having the
 * calc engine fill in values.
 */
export function emptyLayerPricing(i) {
  return {
    layer: `L${i + 1}`, limit: '', deductible: '', risk: false, cat: false,
    // Risk component actuarial fields
    riskPureBurn: '', riskPareto: '', riskAvgBurnPareto: '', riskExposure: '',
    riskWeightBurn: '50', riskWeightPareto: '0', riskWeightExposure: '50', riskLoading: '15',
    riskTotalPrice: '', riskUwPrice: '',
    riskPrAttach: '', riskPrExhaust: '',
    // Cat component actuarial fields
    catPureBurn: '', catPareto: '', catAvgBurnPareto: '', catExposure: '',
    catWeightBurn: '50', catWeightPareto: '0', catWeightExposure: '50', catLoading: '15',
    catTotalPrice: '', catUwPrice: '',
    catPrAttach: '', catPrExhaust: '',
    // Combined (uwPrice = riskUwPrice + catUwPrice, or whichever component is active)
    totalPrice: '', uwPrice: '',
    // Pricing / comparison columns
    reinsurerPricing: '', leadPricing: '', expiringPricing: '', historicalMargin: '',
    reinsurerMarginVsLead: '', reinsurerMargin: '', technicalRatio: '',
    share: '', premium: '', perRiskLimit: '', catLimit: '', cedantTotalLimit: '',
    countryAgg: '', totalCountryAgg: '', annualAggLimit: '', expectedShortfall: '',
  };
}

/**
 * Recompute the combined UW price for a layer from its active
 * components. A layer can be risk-only, cat-only, or both — the sum
 * is taken over whichever components are flagged active on the layer.
 */
export function deriveCombinedUwPrice(l) {
  const riskUw = toN(l.riskUwPrice || l.riskTotalPrice);
  const catUw  = toN(l.catUwPrice  || l.catTotalPrice);
  const hasRisk = l.risk;
  const hasCat  = l.cat;
  if (hasRisk && hasCat) return riskUw + catUw;
  if (hasRisk) return riskUw;
  if (hasCat)  return catUw;
  return 0;
}

// Canonical total-price formula lives in shared/pricingMath.js so the
// server can spot-check client submissions against the exact same
// math. Re-exported here for the screens that already import from
// formatters.
export { deriveComponentTotal } from '../../../../../shared/pricingMath.js';
