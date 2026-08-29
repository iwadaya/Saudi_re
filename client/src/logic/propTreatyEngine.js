// ── Shared proportional-treaty financial helpers ──
// Single source of truth for: loss cap, commission (fixed + sliding),
// profit commission with LCF, and loss-participation credit.
// Used by Quick Summary's financial engine and by the Pricing Moving Average
// charts so both screens compute margin / commission consistently.

import { toN } from '../utils/format';

export function cn(v) {
  return toN(v);
}

// LOSS CAP: caps claims at a % of premium before any calculation.
// Cap source, in order: explicit loss_cap_pct → AAL-derived cap → no cap.
export function applyLossCap(claims, prem, t) {
  if (prem <= 0) return claims;
  let capPct = cn(t.loss_cap_pct);
  if (!(capPct > 0)) {
    const aal = cn(t.aal);
    if (aal > 0) capPct = (aal / prem) * 100;
  }
  if (capPct > 0) return Math.min(claims, prem * capPct / 100);
  return claims;
}

// Sliding-commission table lookup with linear interpolation between points.
function commPctFromTable(lr, table) {
  const pts = (table || [])
    .map(r => ({ lr: cn(r.loss_ratio_pct ?? r.lossRatioPct), c: cn(r.commission_pct ?? r.commissionPct) }))
    .filter(p => Number.isFinite(p.lr) && Number.isFinite(p.c))
    .sort((a, b) => a.lr - b.lr);
  if (pts.length < 2) return null;
  if (lr <= pts[0].lr) return pts[0].c;
  if (lr >= pts[pts.length - 1].lr) return pts[pts.length - 1].c;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (lr >= a.lr && lr <= b.lr) {
      const rng = b.lr - a.lr;
      if (!rng) return a.c;
      return a.c + ((lr - a.lr) / rng) * (b.c - a.c);
    }
  }
  return pts[pts.length - 1].c;
}

export function calcComm(prem, claims, t) {
  if (!prem || prem <= 0) return 0;
  const cappedClaims = applyLossCap(claims, prem, t);
  if ((t.mode || 'FIXED').toUpperCase() === 'FIXED') {
    return prem * (cn(t.fixed_commission_pct) / 100);
  }
  const lr = (cappedClaims / prem) * 100;
  const tablePct = commPctFromTable(lr, t.sliding_table);
  if (tablePct != null) return prem * (tablePct / 100);
  const minLR = cn(t.sliding_min_loss_ratio), maxLR = cn(t.sliding_max_loss_ratio) || 100;
  const minC = cn(t.sliding_min_commission), maxC = cn(t.sliding_max_commission);
  if (lr <= minLR) return prem * (maxC / 100);
  if (lr >= maxLR) return prem * (minC / 100);
  const rng = maxLR - minLR; if (!rng) return prem * (minC / 100);
  return prem * ((maxC - ((lr - minLR) / rng) * (maxC - minC)) / 100);
}

// Stateful PC calculator with FIFO loss carry-forward. Caller must invoke in
// chronological order; returns one closure per stream (projected vs actual).
//
// LCF term encoding (PropTreatyDetail.jsx save payload):
//   'Extinction' → { lcf_years: null, lcf_extinction: true }
//       deficits carry forward PERPETUALLY until absorbed by profits.
//   'N years'    → { lcf_years: N, lcf_extinction: false }
//       a year-Y deficit can offset profits in years Y+1 .. Y+N, then expires.
//   Neither set  → no carry-forward: PC is paid on each profitable year alone.
export function makePCCalc(t) {
  const pct = cn(t.profit_commission_pct) / 100;
  const mgmtPct = cn(t.mgmt_expenses_pct) / 100;
  const lcfYears = cn(t.lcf_years);
  const extinction = !!t.lcf_extinction;
  const lcfActive = extinction || lcfYears > 0;
  const deficits = [];
  return function pcForYear(year, prem, claims, comm) {
    if (!prem || prem <= 0 || pct <= 0) return 0;
    const cappedClaims = applyLossCap(claims, prem, t);
    const mgmt = prem * mgmtPct;
    const yearProfit = prem - cappedClaims - comm - mgmt;
    if (!lcfActive) return yearProfit > 0 ? yearProfit * pct : 0;
    // Time-limited carry-forward: purge deficits older than the N-year
    // window. Extinction never purges — deficits persist until absorbed.
    if (!extinction && lcfYears > 0) {
      while (deficits.length && (year - deficits[0].year) > lcfYears) deficits.shift();
    }
    if (yearProfit <= 0) {
      if (yearProfit < 0) deficits.push({ year, amount: -yearProfit });
      return 0;
    }
    let remaining = yearProfit;
    while (deficits.length && remaining > 0) {
      const d = deficits[0];
      if (d.amount <= remaining) { remaining -= d.amount; deficits.shift(); }
      else { d.amount -= remaining; remaining = 0; }
    }
    return remaining > 0 ? remaining * pct : 0;
  };
}

export function calcLPC(prem, claims, t) {
  if (!t.lp_enabled || !prem || prem <= 0) return 0;
  const cappedClaims = applyLossCap(claims, prem, t);
  const lr = cappedClaims / prem;

  const slides = (t.lp_slides || [])
    .map(r => ({
      minLr: cn(r.min_lr ?? r.minLr) / 100,
      maxLr: (cn(r.max_lr ?? r.maxLr) / 100) || 1,
      share: cn(r.share) / 100,
    }))
    .filter(r => r.share > 0 && r.maxLr > r.minLr);
  // A SINGLE corridor row is a valid LP table (the LP modal allows it) and
  // must price through the band-stacking loop — the legacy single-band
  // fallback below reads lp_reinsurer_share_pct, which is empty when terms
  // were entered as slides, so a `> 1` guard silently returned a 0 credit.
  if (slides.length >= 1) {
    let credit = 0;
    for (const c of slides) {
      const top = Math.min(lr, c.maxLr);
      const bandLoss = Math.max(0, top - c.minLr);
      credit += bandLoss * prem * c.share;
    }
    return credit;
  }

  const sharePct = cn(t.lp_reinsurer_share_pct); if (sharePct <= 0) return 0;
  const minLR = cn(t.lp_min_loss_ratio_pct) / 100;
  const maxLR = cn(t.lp_max_loss_ratio_pct) / 100 || 1;
  if (lr <= minLR) return 0;
  const effectiveLR = Math.min(lr, maxLR);
  const participatingLoss = (effectiveLR - minLR) * prem;
  return participatingLoss * (sharePct / 100);
}

// Build the treaty-terms shape used by the helpers above from a contract
// payload + the in-memory propTreatyDetail. Mirrors the per-screen mapping
// previously inlined in Quick Summary.
export function buildTreatyTerms(contract, td = {}) {
  const c = contract || {};
  const comm = c.commissions || {};
  const det = c.detail || {};
  const lp = c.lossParticipation || c.loss_participation || {};
  const header = c.header || c || {};

  const ttName = (header.treaty_type_name || td.treatyTypeName || '').toUpperCase();
  const isQS = ttName.includes('QUOTA') || ttName.includes('QS');
  const isSurplus = ttName.includes('SURPLUS');
  let fixedCommPct;
  if (isSurplus && !isQS) {
    fixedCommPct = comm.fixed_commission_surplus_pct ?? td.fixedCommissionSurplusPct ?? comm.fixed_commission_qs_pct ?? td.fixedCommissionQSPct ?? 0;
  } else {
    fixedCommPct = comm.fixed_commission_qs_pct ?? td.fixedCommissionQSPct ?? comm.fixed_commission_surplus_pct ?? td.fixedCommissionSurplusPct ?? 0;
  }

  return {
    mode: comm.mode || td.commissionMode || 'FIXED',
    fixed_commission_pct: fixedCommPct,
    sliding_min_loss_ratio: comm.sliding_min_loss_ratio ?? td.slidingMinLossRatio,
    sliding_max_loss_ratio: comm.sliding_max_loss_ratio ?? td.slidingMaxLossRatio,
    sliding_min_commission: comm.sliding_min_commission ?? td.slidingMinCommission,
    sliding_max_commission: comm.sliding_max_commission ?? td.slidingMaxCommission,
    sliding_table: comm.sliding_table ?? td.slidingTable ?? [],
    mgmt_expenses_pct: comm.mgmt_expenses_pct ?? td.mgmtExpensesPct,
    profit_commission_pct: comm.profit_commission_pct ?? td.profitCommissionPct,
    lcf_years: comm.lcf_years ?? td.lcfYears ?? 0,
    lcf_extinction: comm.lcf_extinction ?? td.lcfExtinction ?? false,
    brokerage_pct: det.brokerage_pct ?? td.brokeragePct ?? 0,
    taxes_pct: det.taxes_pct ?? td.taxesPct ?? 0,
    loss_cap_pct: det.loss_cap_pct ?? td.lossCapPct ?? 0,
    // When false, large/cat losses are NOT stripped — the summaries fold all
    // losses into attritional and show large/cat as nil. Defaults to false.
    strip_large_cat: (det.strip_large_cat_losses ?? td.stripLargeCat ?? false) !== false,
    aal: det.aal ?? td.aal ?? 0,
    lp_enabled: lp.enabled ?? td.lossPartEnabled ?? false,
    lp_min_loss_ratio_pct: lp.min_loss_ratio_pct ?? td.minLossRatioPct ?? 0,
    lp_max_loss_ratio_pct: lp.max_loss_ratio_pct ?? td.maxLossRatioPct ?? 0,
    lp_reinsurer_share_pct: lp.reinsurer_share_pct ?? td.reinsurerSharePct ?? 0,
    lp_slides: lp.slides ?? td.lpSlides ?? [],
  };
}
