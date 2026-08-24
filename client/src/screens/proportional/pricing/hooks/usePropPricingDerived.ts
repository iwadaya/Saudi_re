// hooks/usePropPricingDerived.ts — Phase 4.2 (docs/frontend-hardening.md).
//
// PropPricing's per-render derived pricing surface — the component-grid
// readers (getC) and combined-ratio calculators, the treaty-level derived
// values, the FX/display helpers, the hero driver rows and the AI line
// suggestion — moved VERBATIM from the screen (bodies, memo dependency
// arrays). Pure derivation: no effects, no dispatches; called by
// usePropPricingState between the auto-calc effect and the share-grid
// auto-fill effect, exactly where these computations sat in the original
// component body.

import { useCallback, useMemo } from 'react';
import { buildTreatyTerms } from '../../../../logic/propTreatyEngine';
import {
  cn, fmt, fmtPct, parsePct,
  UW_MAX_LIMIT,
} from '../components/propPricingConstants.js';
import type { AnyRecord, ComponentsGrid } from '../state/propPricingReducer';

export interface UsePropPricingDerivedParams {
  contract: AnyRecord;
  td: AnyRecord;
  components: ComponentsGrid;
  fxRates: Record<string, number>;
  showUSD: boolean;
}

export function usePropPricingDerived({
  contract,
  td,
  components,
  fxRates,
  showUSD,
}: UsePropPricingDerivedParams) {
  // ── Component helpers ─────────────────────────────────────────────────────
  const getC = useCallback((row: string, col: string) => components[row]?.[col] || '', [components]);

  const calcResult = useCallback((col: string) => {
    return 1 - parsePct(getC('Attritional Loss Ratio', col)) - parsePct(getC('Large Loss Loading', col))
      - parsePct(getC('Cat Loss Loading', col)) - parsePct(getC('Commissions', col))
      - parsePct(getC('Brokerage', col)) - parsePct(getC('Taxes', col));
  }, [getC]);

  const calcCR = useCallback((col: string) => {
    return parsePct(getC('Attritional Loss Ratio', col)) + parsePct(getC('Large Loss Loading', col))
      + parsePct(getC('Cat Loss Loading', col)) + parsePct(getC('Commissions', col))
      + parsePct(getC('Brokerage', col)) + parsePct(getC('Taxes', col));
  }, [getC]);

  const calcMaxComm = useCallback((col: string) => {
    return 1 - parsePct(getC('Attritional Loss Ratio', col)) - parsePct(getC('Large Loss Loading', col))
      - parsePct(getC('Cat Loss Loading', col)) - parsePct(getC('Brokerage', col))
      - parsePct(getC('Taxes', col)) - 0.10;
  }, [getC]);

  // ── Treaty-level derived values ───────────────────────────────────────────
  const hdr = contract.header || contract || {};
  const det2 = contract.detail || {};
  const rawCurrency = hdr.currency_code || td.currencyCode || hdr.currency || td.currency || '';
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';
  const fxRate = fxRates[currency] || 1;
  const fxInverse = fxRate > 0 ? 1 / fxRate : 1;
  const treatyType = hdr.treaty_type_name || td.treatyTypeName || 'Proportional';
  const epi = (cn(td.quotaShareEpi) + cn(td.surplusEpi)) || (cn(det2.quota_share_epi) + cn(det2.surplus_epi));
  const limit = cn(td.qsLimit) || cn(det2.qs_limit) || cn(td.totalCapacity) || cn(det2.total_capacity);
  const eventLimit = cn(td.eventLimit) || cn(det2.event_limit);
  const tMode = (() => { const n = String(treatyType).toLowerCase(); if (n.includes('quota') && n.includes('surplus')) return 'both'; if (n.includes('quota')) return 'quota'; if (n.includes('surplus') || n.includes('fac oblig')) return 'surplus'; return 'quota'; })();
  const isQS = tMode === 'quota' || tMode === 'both';
  const isSurplus = tMode === 'surplus' || tMode === 'both';
  const qsLimit = cn(td.qsLimit) || cn(det2.qs_limit);
  const retentionPct = cn(td.retentionPct) || cn(det2.retention_pct);
  const retentionAmt = cn(td.retentionAmt) || cn(det2.retention_amt);
  const surplusRetention = cn(td.surplusMaxRetention) || cn(det2.surplus_max_retention);
  const numLines = cn(td.numLines) || cn(det2.num_lines);
  const totalCapacity = cn(td.totalCapacity) || cn(det2.total_capacity);
  const combinedTotalLimit = tMode === 'both' ? (qsLimit * numLines + qsLimit) : totalCapacity;
  const commData = contract.commissions || {};
  const commissionPctVal = cn(td.fixedCommissionQSPct) || cn(commData.fixed_commission_qs_pct) || cn(td.fixedCommissionSurplusPct) || cn(commData.fixed_commission_surplus_pct);
  const profitCommPct = cn(td.profitCommissionPct) || cn(commData.profit_commission_pct);
  const mgmtExpPct = cn(td.mgmtExpensesPct) || cn(commData.mgmt_expenses_pct);
  const taxesPctVal = cn(td.taxesPct) || cn(det2.taxes_pct);
  const brokeragePctVal = cn(td.brokeragePct) || cn(det2.brokerage_pct);
  const uwYear = td.inceptionDate ? new Date(td.inceptionDate).getFullYear() : (contract.uw_year || td.startYear || hdr.uw_year || '—');
  const cedant  = hdr.cedant_name  || hdr.company_name  || td.cedantName  || '';
  const country = hdr.country_name || hdr.country       || td.countryName || td.country || '';
  const broker  = hdr.broker_name  || hdr.broker        || td.brokerName  || td.broker  || '';
  const crAct = calcCR('actuarial');
  const crUw = calcCR('uw');
  const marginAct = 1 - crAct;
  const marginUw = 1 - crUw;

  // Treaty terms for the Moving Average charts. Memoized so the child's
  // per-year financial calc doesn't re-run on every parent render.
  const movingAvgTerms = useMemo(() => buildTreatyTerms(contract, td), [contract, td]);

  // ── FX / display helpers ──────────────────────────────────────────────────
  const safeCcy = currency;
  const displayCcy = showUSD && safeCcy !== 'USD' ? 'USD' : safeCcy;
  const toDisplay = (n: any) => { const v = Number(n); if (!Number.isFinite(v) || v === 0) return 0; return showUSD && safeCcy !== 'USD' ? v * fxRate : v; };
  const money = (n: any) => { const v = toDisplay(n); return v !== 0 ? `${displayCcy} ${fmt(Math.round(v))}` : '—'; };
  const fxLabel = safeCcy !== 'USD' && fxRate !== 1 ? `1 ${safeCcy} = ${fxRate.toFixed(4)} USD (1 USD = ${fxInverse.toFixed(2)} ${safeCcy})` : null;

  // ── Driver rows for hero ──────────────────────────────────────────────────
  const drvAtt = parsePct(getC('Attritional Loss Ratio', 'actuarial'));
  const drvLL  = parsePct(getC('Large Loss Loading', 'actuarial'));
  const drvCat = parsePct(getC('Cat Loss Loading', 'actuarial'));
  const drvComm = parsePct(getC('Commissions', 'actuarial'));
  const drvBrok = parsePct(getC('Brokerage', 'actuarial'));
  const drvTax  = parsePct(getC('Taxes', 'actuarial'));
  const balance = 1 - drvAtt - drvLL - drvCat - drvComm - drvBrok - drvTax;
  const drivers = [
    { k: 'Attritional LR', v: drvAtt, threshold: [0.55, 0.70] },
    { k: 'Large Loss Load', v: drvLL,  threshold: [0.05, 0.15] },
    { k: 'Cat Loss Load',   v: drvCat, threshold: [0.05, 0.15] },
    { k: 'Commissions',     v: drvComm,threshold: [0.28, 0.325] },
    { k: 'Brokerage',       v: drvBrok,threshold: [0.03, 0.05] },
    { k: 'Taxes',           v: drvTax, threshold: [0.02, 0.05] },
  ];

  // ── AI line suggestion ────────────────────────────────────────────────────
  const balanceRatio = epi > 0 ? limit / epi : 0;
  const aiCalc = useMemo(() => {
    const lrVal = parsePct(getC('Attritional Loss Ratio', 'actuarial'));
    const premScore = Math.min(100, Math.round((Math.min(balanceRatio || 0, 80) / 80) * 50 + (limit > 0 ? Math.min(limit / 5_000_000_000, 1) * 50 : 0)));
    const margScore = Math.min(100, Math.round((Math.max(0, Math.min(marginAct, 0.5)) / 0.5) * 60 + (Math.max(0, 0.7 - lrVal) / 0.7) * 40));
    const aiRawPct = Math.round((Math.max(0, Math.min(1, marginAct / 0.3)) * 0.6 + Math.max(0, Math.min(1, (balanceRatio || 0) / 60)) * 0.4) * 20 * 10) / 10;
    const aiLinePct = Math.max(1, Math.min(20, aiRawPct || 10));
    const aiLimitLine = Math.round(limit * aiLinePct / 100);
    const aiPremLine  = Math.round(epi * aiLinePct / 100);
    const aiWithinAuth = aiLimitLine <= Math.round(UW_MAX_LIMIT * (fxInverse > 0 ? fxInverse : 1));
    const heatLabel = premScore > 65 && margScore > 65 ? 'Premium & Margin Driver' : premScore > 65 ? 'Premium Driver' : margScore > 65 ? 'Margin Driver' : 'Balanced';
    const heatColor = premScore > 65 && margScore > 65 ? '#a78bfa' : premScore > 65 ? '#00d4ff' : margScore > 65 ? '#4ade80' : '#94a3b8';
    const reason = marginAct >= 0.15 ? `Strong actuarial margin (${fmtPct(marginAct)}) supports a full line.` : marginAct >= 0.08 ? `Acceptable margin (${fmtPct(marginAct)}); moderate line recommended.` : `Thin margin (${fmtPct(marginAct)}); conservative line advised.`;
    return { premScore, margScore, aiLinePct, aiLimitLine, aiPremLine, aiWithinAuth, heatLabel, heatColor, reason };
  }, [marginAct, balanceRatio, limit, epi, getC, fxInverse]);

  // ── Retro impact inputs (offer modal → RetroImpactModal) ─────────────────
  // The retro optimiser needs the loss/expense split, not just the combined
  // ratio: retro recoveries only touch the loss piece while acquisition
  // costs stay with us. Both come off the actuarial column.
  const retroInputs = useMemo(() => ({
    grossPremium100: epi,
    grossLimit100: limit,
    expectedLossRatio: drvAtt + drvLL + drvCat,
    expenseRatio: drvComm + drvBrok + drvTax,
    authorityMaxLimit: Math.round(UW_MAX_LIMIT * (fxInverse > 0 ? fxInverse : 1)),
  }), [epi, limit, drvAtt, drvLL, drvCat, drvComm, drvBrok, drvTax, fxInverse]);

  return {
    getC, calcResult, calcCR, calcMaxComm,
    hdr, det2, currency, fxRate, fxInverse, treatyType,
    epi, limit, eventLimit, tMode, isQS, isSurplus,
    qsLimit, retentionPct, retentionAmt, surplusRetention, numLines,
    totalCapacity, combinedTotalLimit,
    commissionPctVal, profitCommPct, mgmtExpPct, taxesPctVal, brokeragePctVal,
    uwYear, cedant, country, broker,
    crAct, crUw, marginAct, marginUw,
    movingAvgTerms,
    safeCcy, displayCcy, toDisplay, money, fxLabel,
    balance, drivers, aiCalc, retroInputs,
  };
}

export type PropPricingDerived = ReturnType<typeof usePropPricingDerived>;
export default usePropPricingDerived;
