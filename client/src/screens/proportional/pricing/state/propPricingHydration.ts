// state/propPricingHydration.ts — Phase 4.2 (docs/frontend-hardening.md).
//
// Pure hydration helpers for PropPricing's main load. Each function body
// is the corresponding block of the screen's load effect moved VERBATIM
// (TS annotations only — zero runtime change); the effect in
// hooks/usePropPricingState.ts keeps the original setter SEQUENCE and
// conditions, calling these to compute the values it hydrates with.

import { DEFAULT_SHARE_ROWS, cn } from '../components/propPricingConstants.js';
import type { AnyRecord, ComponentsGrid, ShareGrid } from './propPricingReducer';

/** Normalize DB status values to UI status values. */
export const normalizeStatus = (s: unknown): string => {
  if (!s) return 'DRAFT';
  const u = String(s).toUpperCase();
  if (u === 'RETURNED' || u === 'RECALLED') return 'DRAFT';
  if (u === 'OFFERED' || u === 'PENDING') return 'DRAFT';
  return u;
};

/** rate rows → { currency_code: rate_to_usd } map, USD pinned at 1. */
export function buildFxRateMap(rates: unknown): Record<string, number> {
  const rateMap: Record<string, number> = { USD: 1 };
  (Array.isArray(rates) ? rates : []).forEach((rx: AnyRecord) => {
    if (rx.currency_code && rx.rate_to_usd) rateMap[rx.currency_code] = Number(rx.rate_to_usd);
  });
  return rateMap;
}

/**
 * Map saved share scenarios into the canonical 4 default rows by label;
 * ignore any extras (never append user-typed label accidents).
 */
export function buildSavedShareGrid(p: AnyRecord): ShareGrid {
  const sg: ShareGrid = {};
  p.share_scenarios.forEach((s: AnyRecord) => {
    if (DEFAULT_SHARE_ROWS.includes(s.share_label)) sg[s.share_label] = s;
  });
  return sg;
}

/**
 * Saved component rows → grid, then seed the Commissions / Brokerage /
 * Taxes rows (actuarial + actual) from the treaty terms — the same
 * blended-commission / sliding-scale arithmetic the auto-calc effect
 * re-derives once loading completes.
 */
export function buildHydratedComponents(p: AnyRecord, c: AnyRecord, td: AnyRecord): ComponentsGrid {
  const cg: ComponentsGrid = {};
  for (const comp of (p.components || [])) {
    cg[comp.component_name] = {
      actuarial: comp.actuarial_value || '', uw: comp.uw_value || comp.underwriter_value || '',
      market: comp.market_value || '', actual: comp.actual_stats_value || '',
      exposure: comp.exposure_value || '', comment: comp.comment || '',
    };
  }

  const det = c?.detail || {};
  const cmm = c?.commissions || {};
  const qsPremL = cn(td.quotaShareEpi) || cn(det.quota_share_epi);
  const surPremL = cn(td.surplusEpi) || cn(det.surplus_epi);
  const isSlidingL = String(td.commissionMode || '').toLowerCase().includes('slid');
  const provL = cn(td.provisionalCommissionPct) / 100;
  const qsFixedL = (cn(td.fixedCommissionQSPct) || cn(cmm.fixed_commission_qs_pct) || cn(cmm.fixed_commission_pct)) / 100;
  const surFixedL = (cn(td.fixedCommissionSurplusPct) || cn(cmm.fixed_commission_surplus_pct) || cn(cmm.fixed_commission_pct)) / 100;
  let commPctL = 0;
  if (isSlidingL && provL > 0) { commPctL = provL; }
  else { const tp = qsPremL + surPremL; commPctL = tp > 0 ? (qsPremL * qsFixedL + surPremL * surFixedL) / tp : (qsFixedL || surFixedL); }
  const brokPctL = (cn(td.brokeragePct) || cn(det.brokerage_pct)) / 100;
  const taxPctL = (cn(td.taxesPct) || cn(det.taxes_pct)) / 100;
  const fmtV = (val: any) => typeof val === 'number' ? `${(val * 100).toFixed(2)}%` : val;
  const injectCBT = (row: string, val: number) => {
    if (!cg[row]) cg[row] = {};
    const fv = fmtV(val);
    cg[row].actuarial = fv; cg[row].actual = fv;
  };
  injectCBT('Commissions', commPctL); injectCBT('Brokerage', brokPctL); injectCBT('Taxes', taxPctL);
  return cg;
}
