import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId } from '../../../hooks/useContractId';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { loadProjectedRows } from '../../../logic/projectWithSavedFactors';
import { buildTreatyTerms } from '../../../logic/propTreatyEngine';
import { loadLossCategoryByYear, deriveLossComponents } from '../../../logic/lossCategoryAmounts';
import LossSelectionScreen from '../../shared/LossSelectionScreen';
import ProfileScreen from '../../shared/ProfileScreen';
import PropCrestaAggregates from '../cresta_zones/PropCrestaAggregates';
import AggDrilldownModal from './components/AggDrilldownModal';
import InDepthPortfolioModal from './components/InDepthPortfolioModal';
import { QuickSummaryEmbed } from '../quick_summary/PropQuickSummary';
import { getRole, getUserDisplayName, getSession } from '../../../utils/auth';
import { useGlobalToast } from '../../../hooks/useToast';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';
import { formatPricingDriftMessage } from '../../../utils/pricingErrors';

// ── Sub-components ──────────────────────────────────────────────────────────
import PropBloombergHero from './components/PropBloombergHero';
import PropComponentTable from './components/PropComponentTable';
import PropShareScenarios from './components/PropShareScenarios';
import PropOfferModal from './components/PropOfferModal';
import PropMovingAverageCharts from './components/PropMovingAverageCharts';
import { ChecklistPanel } from './components/insight/ChecklistPanel';
import { AggCobBreakdownModal } from './components/insight/AggCobBreakdownModal';
import CedantSummaryTabs from '../../../components/cedant/CedantSummaryTabs';
import MarketIntelligenceModal from '../../../components/market/MarketIntelligenceModal.jsx';
import { CompareTermsPanel } from './components/insight/CompareTermsPanel';
import { InternalMetricsPanel } from './components/insight/InternalMetricsPanel';
import { TreatyMetricsPanel } from './components/insight/TreatyMetricsPanel';
import {
  COMPONENT_ROWS, DEFAULT_SHARE_ROWS, INSIGHT_BUTTONS,
  cn, fmt, fmtPct, parsePct, mbbefdG, SWISS_RE_C, fitPareto,
  UW_MAX_LIMIT,
} from './components/propPricingConstants';
import { paretoLayerExpectedLoss } from '../../../utils/npPricingEngine';

import { exportPropPricingToExcel } from './exportPropPricingToExcel.js';

const ROUTE_KEY = 'PROP_PRICING';

export default function PropPricing() {
  const { state: appState } = useAppState();
  const contractId = useContractId();
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const loadedRef = useRef(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [contract, setContract] = useState({});
  const [components, setComponents] = useState({});
  // Rows whose UW cell the user has explicitly edited — these are no longer
  // re-seeded from the actuarial column when it re-calculates.
  const [uwUserEdited, setUwUserEdited] = useState(new Set());
  const [leads, setLeads] = useState({});
  const [shareRows, setShareRows] = useState(DEFAULT_SHARE_ROWS.slice());
  const [shareGrid, setShareGrid] = useState({});
  const shareGridRef = React.useRef(shareGrid);
  shareGridRef.current = shareGrid;
  const [contractAgg100, setContractAgg100] = useState(null);
  const [otherCountryAgg, setOtherCountryAgg] = useState(null);
  const [cobLabel, setCobLabel] = useState('');
  const [reinsurers, setReinsurers] = useState([]);
  const [yearly, setYearly] = useState([]);
  const [comment, setComment] = useState('');
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [showOffer, setShowOffer] = useState(false);
  const [offerLine, setOfferLine] = useState('');
  const [offerComment, setOfferComment] = useState('');
  const [offerApprover, setOfferApprover] = useState('');
  const [eligibleApprovers, setEligibleApprovers] = useState([]);
  const [returnReason, setReturnReason] = useState('');
  const [approvalTrail, setApprovalTrail] = useState([]);
  const userRole = useMemo(() => getRole(), []);
  const userSession = useMemo(() => getSession(), []);
  // CE, CU, TD, TM can all approve (hierarchy_level <= 4)
  const isCU = getRole() === 'CU' || getRole() === 'CE'; // only CU/CE see the approver panel
  const actorName = useMemo(() => getUserDisplayName(), []);
  const showToast = useGlobalToast();
  const [mandateCheck] = React.useState(null);
  const [showMandateBlock, setShowMandateBlock] = React.useState(false);
  const [offerStatus, setOfferStatusState] = useState('DRAFT');
  const [signedLinePct, setSignedLinePct] = useState('');
  const [insightOpen, setInsightOpen] = useState(false);
  const [insightKey, setInsightKey] = useState('');
  const [fxRates, setFxRates] = useState({});
  const [showUSD, setShowUSD] = useState(false);
  const [worstLR, setWorstLR] = useState({ lr: null, year: '' });
  // True when pricing fell back to placeholder benchmark curves (no saved
  // pricing rows, no saved factors, no triangle, no saved blend).
  const [usedPlaceholderLdfs, setUsedPlaceholderLdfs] = useState(false);
  // True when large/cat losses were edited after the loss selection was saved.
  const [lossStale, setLossStale] = useState(false);
  const [showQuickSummary, setShowQuickSummary] = useState(false);
  const [showMarketIntelligence, setShowMarketIntelligence] = useState(false);
  const [showAggBreakdown, setShowAggBreakdown] = useState(false);
  const [showInDepth, setShowInDepth] = useState(false);
  const [showAggDrilldown, setShowAggDrilldown] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [snapLabel, setSnapLabel] = useState('');
  const [showSnapHistory, setShowSnapHistory] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const td = useMemo(() => appState.propTreatyDetail || {}, [appState.propTreatyDetail]);
  const cid = contractId || td.contractId;

  // ── Reset when contract changes ──────────────────────────────────────────
  const prevCidRef = React.useRef(cid);
  useEffect(() => {
    if (prevCidRef.current !== cid) {
      prevCidRef.current = cid;
      setLoading(true); setDirty(false); setSaveMsg(null);
      setContract({}); setComponents({}); setUwUserEdited(new Set()); setLeads({});
      setShareRows(DEFAULT_SHARE_ROWS.slice()); setShareGrid({});
      setReinsurers([]); setYearly([]); setComment('');
      setLastUpdatedAt(null);
      setOfferLine(''); setOfferComment(''); setOfferApprover('');
      setOfferStatusState('DRAFT'); setSignedLinePct('');
      setShowOffer(false); setShowDecline(false);
      setInsightOpen(false); setShowUSD(false);
    }
  }, [cid]);

  // ── Load eligible approvers for the offer dropdown ─────────────────────
  useEffect(() => {
    if (!cid) return;
    api.getEligibleApprovers(cid, {}).then(rows => {
      setEligibleApprovers(Array.isArray(rows) ? rows : []);
    }).catch(() => {});
  }, [cid]);

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!cid) { setLoading(false); return; }
    Promise.all([
      api.getContract(cid).catch(() => ({})),
      api.getPricing(cid).catch(() => ({})),
      api.listReinsurers().catch(() => []),
      api.getPricingYearly(cid).catch(() => []),
      api.getExchangeRates().catch(() => []),
      api.getComponentSnapshots(cid).catch(() => []),
    ]).then(([c, p, r, y, rates, snaps]) => {
      const hdr = c?.header || c || {};
      setContract(c || {}); setReinsurers(Array.isArray(r) ? r : []);
      setLastUpdatedAt(hdr.updated_at || c?.updated_at || null);
      setYearly(Array.isArray(y) ? y : []);
      setSnapshots(Array.isArray(snaps) ? snaps : []);

      const rateMap = { USD: 1 };
      (Array.isArray(rates) ? rates : []).forEach(rx => {
        if (rx.currency_code && rx.rate_to_usd) rateMap[rx.currency_code] = Number(rx.rate_to_usd);
      });
      setFxRates(rateMap);

      if (p.leads) setLeads(p.leads);
      if (p.share_scenarios?.length) {
        // Always use the canonical 4 rows — never append user-typed label accidents.
        // Map saved data into the default rows by label; ignore any extras.
        setShareRows(DEFAULT_SHARE_ROWS.slice());
        const sg = {};
        p.share_scenarios.forEach(s => {
          if (DEFAULT_SHARE_ROWS.includes(s.share_label)) sg[s.share_label] = s;
        });
        setShareGrid(sg);
      }

      const cg = {};
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
      const fmtV = val => typeof val === 'number' ? `${(val * 100).toFixed(2)}%` : val;
      const injectCBT = (row, val) => {
        if (!cg[row]) cg[row] = {};
        const fv = fmtV(val);
        cg[row].actuarial = fv; cg[row].actual = fv;
      };
      injectCBT('Commissions', commPctL); injectCBT('Brokerage', brokPctL); injectCBT('Taxes', taxPctL);
      setComponents(cg);

      // Normalize DB status values to UI status values
      const normalizeStatus = (s) => {
        if (!s) return 'DRAFT';
        const u = String(s).toUpperCase();
        if (u === 'RETURNED') return 'DRAFT';
        if (u === 'OFFERED' || u === 'PENDING') return 'DRAFT';
        return u;
      };
      const savedStatus = normalizeStatus(hdr.status || p.outputs?.offer_status || p.outputs?.status);
      setOfferStatusState(savedStatus);
      setComment(p.outputs?.uw_comment || p.comment || '');
      if (p.outputs?.offer_line) setOfferLine(p.outputs.offer_line);
      if (p.outputs?.offer_comment) setOfferComment(p.outputs.offer_comment);
      if (p.outputs?.offer_approver) setOfferApprover(p.outputs.offer_approver);
      // signed_line_pct: prefer contract table (authoritative after Mark Signed), fall back to JSONB
      const sl = hdr.signed_line_pct ?? p.outputs?.signed_line_pct;
      if (sl) setSignedLinePct(String(sl));
      setLoading(false);
      loadedRef.current = true;

      const st = normalizeStatus(hdr.status || p.outputs?.offer_status || p.outputs?.status);
      // Auto-open offer modal based on role + status
      if (st === 'AWAITING_APPROVAL') setShowOffer(true);
      if (st === 'AWAITING_SIGNED_LINE') setShowOffer(true);
      if (st === 'DISPUTE_PENDING') setShowOffer(true);
    }).catch(e => { console.error('Pricing load failed:', e); setLoading(false); });
  }, [cid, td.brokeragePct, td.commissionMode, td.fixedCommissionQSPct, td.fixedCommissionSurplusPct, td.provisionalCommissionPct, td.quotaShareEpi, td.surplusEpi, td.taxesPct]);

  useEffect(() => {
    if (cid) api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  }, [cid]);

  // ── Auto-calculate actuarial / actual / market / downside columns ─────────
  useEffect(() => {
    if (!cid || loading) return;
    const det = contract.detail || {};
    const comm = contract.commissions || {};
    let commissionPct = 0;
    const qsPrem = cn(td.quotaShareEpi) || cn(det.quota_share_epi);
    const surPrem = cn(td.surplusEpi) || cn(det.surplus_epi);
    const isSliding = String(td.commissionMode || '').toLowerCase().includes('slid');
    const prov = cn(td.provisionalCommissionPct) / 100;
    const qsFixed = (cn(td.fixedCommissionQSPct) || cn(comm.fixed_commission_qs_pct) || cn(comm.fixed_commission_pct)) / 100;
    const surFixed = (cn(td.fixedCommissionSurplusPct) || cn(comm.fixed_commission_surplus_pct) || cn(comm.fixed_commission_pct)) / 100;
    if (isSliding && prov > 0) { commissionPct = prov; }
    else { const tp = qsPrem + surPrem; if (tp > 0) commissionPct = (qsPrem * qsFixed + surPrem * surFixed) / tp; else commissionPct = qsFixed || surFixed; }
    const brokeragePct = (cn(td.brokeragePct) || cn(det.brokerage_pct)) / 100;
    const taxesPct = (cn(td.taxesPct) || cn(det.taxes_pct)) / 100;
    const effEpi = qsPrem + surPrem || 0;
    const treatyCapacity =
      cn(td.totalCapacity) || cn(det.total_capacity) ||
      cn(td.qsLimit)       || cn(det.qs_limit) || 0;
    const treatyEventLimit =
      cn(td.eventLimit) || cn(det.event_limit) || 0;
    const catCap = treatyEventLimit > 0 ? treatyEventLimit : treatyCapacity * 3;
    const fmtV = val => typeof val === 'number' ? `${(val * 100).toFixed(2)}%` : val;

    setComponents(prev => {
      const nc = { ...prev };
      const force = (row, col, val) => { if (!nc[row]) nc[row] = {}; nc[row] = { ...nc[row], [col]: fmtV(val) }; };
      force('Commissions', 'actuarial', commissionPct); force('Brokerage', 'actuarial', brokeragePct); force('Taxes', 'actuarial', taxesPct);
      force('Commissions', 'actual', commissionPct); force('Brokerage', 'actual', brokeragePct); force('Taxes', 'actual', taxesPct);
      return nc;
    });

    (async () => {
      try {
        const projectedLRs = [], actualLRs = [];
        // Totals (premium-weighted) feed the attritional & actual loadings.
        let totProjLoss = 0, totProjPrem = 0, totActLoss = 0, totActPrem = 0;
        if (yearly.length > 0) {
          yearly.forEach(r => {
            const p = cn(r.ultimate_premium), l = cn(r.ultimate_loss);
            const rt = String(r.record_type || '').toUpperCase();
            if (p > 0 && rt === 'PROJECTED') { projectedLRs.push(l / p); totProjLoss += l; totProjPrem += p; }
            if (p > 0 && rt === 'ACTUAL') { actualLRs.push(l / p); totActLoss += l; totActPrem += p; }
          });
        }
        // Projection philosophy: loadProjectedRows projects the incurred triangle
        // (stripped or full, per treaty setting) and returns per-year ultimates.
        // On the STRIPPED basis, deriveLossComponents subtracts selected large/CAT
        // losses from projected incurred to recover the attritional component; the
        // separate Pareto-fitted large/CAT loadings are then added back explicitly.
        // On the FULL basis, large/CAT are already baked into the projected ultimates
        // so no subtraction is applied — attrLR carries the combined loss ratio and
        // the Pareto loadings represent the explicit large/CAT charge on top.
        // The underwriter column is where the two bases are reconciled.
        // It is the same path the Projected Summary uses, so both screens
        // always report consistent ultimates.
        // Note: the stripLC gate applies only to the projected (actuarial) basis —
        // the actual basis always subtracts totalLarge/totalCat since totActLoss is
        // always raw incurred regardless of triangle setting.
        //
        // Run it unconditionally: the placeholder flag must reflect the CURRENT projection
        // regardless of whether saved yearly pricing rows exist — otherwise a treaty whose
        // dev factors were deleted/reset after a prior save would keep hiding the warning.
        // Its rows only feed the LRs when there are no saved yearly rows to drive them.
        const proj = await loadProjectedRows(cid, appState.quoteMode ? { quote: true } : undefined);
        setUsedPlaceholderLdfs(!!proj.usedPlaceholderLdfs);
        if (!projectedLRs.length) {
          (proj.rows || []).forEach(r => {
            if (r.ultPrem > 0) { projectedLRs.push(r.ultLoss / r.ultPrem); totProjLoss += r.ultLoss; totProjPrem += r.ultPrem; }
            if (r.actPrem > 0) { actualLRs.push(r.actLoss / r.actPrem); totActLoss += r.actLoss; totActPrem += r.actPrem; }
          });
        }
        const avgActualLR = actualLRs.length ? actualLRs.reduce((a, b) => a + b, 0) / actualLRs.length : 0;
        const avgProjectedLR = projectedLRs.length ? projectedLRs.reduce((a, b) => a + b, 0) / projectedLRs.length : avgActualLR;

        // Large/CAT totals (raw incurred) and the per-treaty strip flag.
        const lossCat = await loadLossCategoryByYear(cid, appState.quoteMode ? { quote: true } : undefined)
          .catch(() => ({ large: new Map(), cat: new Map() }));
        const totalLarge = [...lossCat.large.values()].reduce((a, b) => a + b, 0);
        const totalCat = [...lossCat.cat.values()].reduce((a, b) => a + b, 0);
        const stripLC = (det.strip_large_cat_losses ?? td.stripLargeCat ?? false) !== false;
        // Attritional on each basis via the shared loss-component model.
        // Actuarial uses projected totals; actual uses unprojected (raw) totals.
        const projComp = deriveLossComponents({ premium: totProjPrem, incurredTotal: totProjLoss, large: stripLC ? totalLarge : 0, cat: stripLC ? totalCat : 0 });
        const actComp = deriveLossComponents({ premium: totActPrem, incurredTotal: totActLoss, large: totalLarge, cat: totalCat });
        const actuarialAttrLR = totProjPrem > 0 ? projComp.attrLR : avgProjectedLR;
        const actualAttrLR = totActPrem > 0 ? actComp.attrLR : avgActualLR;

        let largeLossLoad = 0;
        try {
          const llSnap = await api.getLossSelectionLatest(cid, 'large').catch(() => ({}));
          const snap = llSnap?.snapshot || {};
          const savedAlpha = cn(snap.pareto_alpha);
          const savedXm    = cn(snap.pareto_xm);
          const savedYears = cn(snap.observation_years);
          const savedN     = cn(snap.selected_count);
          console.log('[LARGE LOSS LOAD] snap fields:', {
            savedAlpha, savedXm, savedYears, savedN, treatyCapacity, effEpi,
            primaryGuard: savedAlpha > 1 && savedXm > 0 && savedYears > 0
                          && savedN > 0 && treatyCapacity > savedXm && effEpi > 0,
          });

          if (savedAlpha > 1 && savedXm > 0 && savedYears > 0 && savedN > 0
              && treatyCapacity > savedXm && effEpi > 0) {
            // Primary path: use saved Pareto fit from snapshot.
            largeLossLoad = paretoLayerExpectedLoss(
              savedAlpha, savedXm,
              savedXm, treatyCapacity - savedXm,
              savedN, savedYears
            ) / effEpi;
          } else {
            // Fallback: fit Pareto from raw loss list.
            const rawLL = await api.getLargeLosses(cid).catch(() => []);
            const losses = (rawLL?.losses || rawLL || [])
              .map(l => cn(l.incurred || l.paid) + cn(l.os))
              .filter(v => v > 0);
            if (losses.length >= 3 && treatyCapacity > 0 && effEpi > 0) {
              const sorted = [...losses].sort((a, b) => a - b);
              const xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
              const { alpha, n } = fitPareto(losses, xm);
              const years = Math.max(5, new Set(
                (rawLL?.losses || rawLL || []).map(l => l.uw_year)
              ).size);
              if (alpha > 1 && treatyCapacity > xm) {
                largeLossLoad = paretoLayerExpectedLoss(
                  alpha, xm, xm, treatyCapacity - xm, n, years
                ) / effEpi;
              }
            }
          }
          console.log('[LARGE LOSS LOAD] result:', largeLossLoad);
        } catch (e) { console.error('Large loss load calc failed:', e); }

        let catLoad = 0;
        try {
          const catSnap = await api.getLossSelectionLatest(cid, 'cat').catch(() => ({}));
          const snap = catSnap?.snapshot || {};
          const savedAlpha = cn(snap.pareto_alpha);
          const savedXm    = cn(snap.pareto_xm);
          const savedYears = cn(snap.observation_years);
          const savedN     = cn(snap.selected_count);
          console.log('[CAT LOAD] snap fields:', {
            savedAlpha, savedXm, savedYears, savedN, catCap, treatyEventLimit,
            treatyCapacity, effEpi,
            primaryGuard: savedAlpha > 1 && savedXm > 0 && savedYears > 0
                          && savedN > 0 && catCap > savedXm && effEpi > 0,
          });

          if (savedAlpha > 1 && savedXm > 0 && savedYears > 0 && savedN > 0
              && catCap > savedXm && effEpi > 0) {
            // Primary path: saved Pareto fit, layer up to event limit (or 3× treaty limit).
            catLoad = paretoLayerExpectedLoss(
              savedAlpha, savedXm,
              savedXm, catCap - savedXm,
              savedN, savedYears
            ) / effEpi;
          } else {
            // Fallback: fit Pareto from raw cat loss list.
            const rawCat = await api.getCatLosses(cid).catch(() => []);
            const losses = (rawCat?.losses || rawCat || [])
              .map(l => cn(l.incurred || l.paid) + cn(l.os))
              .filter(v => v > 0);
            if (losses.length >= 3 && catCap > 0 && effEpi > 0) {
              const sorted = [...losses].sort((a, b) => a - b);
              const xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
              const { alpha, n } = fitPareto(losses, xm);
              const years = Math.max(5, new Set(
                (rawCat?.losses || rawCat || []).map(l => l.uw_year)
              ).size);
              if (alpha > 1 && catCap > xm) {
                catLoad = paretoLayerExpectedLoss(
                  alpha, xm, xm, catCap - xm, n, years
                ) / effEpi;
              }
            }
          }
          console.log('[CAT LOAD] result:', catLoad);
        } catch (e) { console.error('Cat load calc failed:', e); }

        let exposureLR = 0;
        let cobIds = [];
        try {
          const cobsRes = await api.getContractCobs(cid).catch(() => []);
          const cobRows = cobsRes?.rows || cobsRes || [];
          const cobList = cobRows.map(x => x.cob_id || x.id || x.class_of_business_id);
          cobIds = cobRows.map(x => x.class_of_business_id || x.cob_id || x.id).filter(Boolean);
          const cobNames = cobRows.map(x => x.name || x.cob_name || x.class_of_business || '').filter(Boolean);
          if (cobNames.length) setCobLabel(cobNames.join(', '));
          let totalExpLoss = 0;
          for (const cobId of cobList) {
            if (!cobId) continue;
            const rp = await api.getRiskProfile(cid, cobId).catch(() => ({}));
            const profile = rp?.profile || rp || {};
            const bands = rp?.bands || [];
            const pmlPct = cn(profile.pml_percentage) || 100;
            const curveKey = profile.selected_curve || 'Y3';
            const curveC = curveKey === 'Custom' ? cn(profile.custom_b) : (SWISS_RE_C[curveKey] ?? 3.0);
            for (const band of bands) {
              const si = cn(band.total_sum_insured || band.sumInsured);
              const maxBand = cn(band.to_amt || band.max);
              if (si <= 0) continue;
              const bandPML = si * (pmlPct / 100);
              if (bandPML > 0) { const d = Math.min(maxBand / bandPML, 1); totalExpLoss += bandPML * mbbefdG(d, curveC); }
            }
          }
          if (totalExpLoss > 0 && effEpi > 0) exposureLR = totalExpLoss / effEpi;
        } catch (e) {}

        let marketAvg = {};
        try {
          const hdrDetail = contract?.header || contract || {};
          const treatyTypeId = hdrDetail.treaty_type_id || td.treatyTypeId || null;
          const countryId = hdrDetail.country_id || td.countryId || td.country_id || '';
          const countryData = countryId ? await api.getCountry(countryId).catch(() => ({})) : {};
          const region = countryData?.region || null;
          if (countryId) {
            marketAvg = await api.getMarketAverage(countryId, cid, { treatyTypeId, cobIds, region }).catch(() => ({}));
          }
        } catch (e) {}

        setComponents(prev => {
          const nc = { ...prev };
          const sc = (row, col, val) => { if (!nc[row]) nc[row] = {}; nc[row] = { ...nc[row], [col]: fmtV(val) }; };
          // Actuarial: attritional stripped of large/CAT (when stripping on);
          // large/CAT shown as the MODELLED loadings (Pareto / return-period).
          sc('Attritional Loss Ratio', 'actuarial', actuarialAttrLR);
          sc('Large Loss Loading', 'actuarial', largeLossLoad);
          sc('Cat Loss Loading', 'actuarial', catLoad);
          // Actual (unprojected burning cost): attritional = (incurred−large−cat)/prem,
          // large = large/prem, cat = cat/prem.
          sc('Attritional Loss Ratio', 'actual', actualAttrLR);
          sc('Large Loss Loading', 'actual', actComp.largeLR);
          sc('Cat Loss Loading', 'actual', actComp.catLR);
          if (exposureLR > 0) {
            sc('Attritional Loss Ratio', 'exposure', exposureLR);
            sc('Large Loss Loading', 'exposure', largeLossLoad);
            sc('Cat Loss Loading', 'exposure', catLoad);
          }
          sc('Commissions', 'exposure', commissionPct); sc('Brokerage', 'exposure', brokeragePct); sc('Taxes', 'exposure', taxesPct);
          const mktComponents = marketAvg?.components || marketAvg || {};
          const mktSet = (row, val) => { const n = Number(val); if (val != null && Number.isFinite(n)) sc(row, 'market', n); };
          mktSet('Attritional Loss Ratio', mktComponents['Attritional Loss Ratio']);
          mktSet('Large Loss Loading', mktComponents['Large Loss Loading']);
          mktSet('Cat Loss Loading', mktComponents['Cat Loss Loading']);
          mktSet('Commissions', mktComponents['Commissions']); mktSet('Brokerage', mktComponents['Brokerage']); mktSet('Taxes', mktComponents['Taxes']);
          const downsideAtt = Math.max(worstLR.lr || 0, 2.50);
          sc('Attritional Loss Ratio', 'downside', downsideAtt);
          sc('Large Loss Loading', 'downside', stripLC ? largeLossLoad : 0); sc('Cat Loss Loading', 'downside', stripLC ? catLoad : 0);
          sc('Commissions', 'downside', commissionPct); sc('Brokerage', 'downside', brokeragePct); sc('Taxes', 'downside', taxesPct);
          for (const rowName of ['Attritional Loss Ratio', 'Large Loss Loading', 'Cat Loss Loading', 'Commissions', 'Brokerage', 'Taxes']) {
            if (nc[rowName]?.actuarial && !uwUserEdited.has(rowName)) nc[rowName] = { ...nc[rowName], uw: nc[rowName].actuarial };
          }
          return nc;
        });
      } catch (e) { console.error('Auto-calc pricing failed:', e); }
    })();
  }, [appState.quoteMode, cid, loading, yearly.length, td.quotaShareEpi, td.surplusEpi, td.fixedCommissionQSPct, td.fixedCommissionSurplusPct, td.brokeragePct, td.taxesPct, td.provisionalCommissionPct, td.commissionMode, td.stripLargeCat, td.totalCapacity, td.qsLimit, td.eventLimit, contract.detail?.total_capacity, contract.detail?.qs_limit, contract.detail?.event_limit, contract.detail?.brokerage_pct, contract.detail?.taxes_pct, contract.commissions?.fixed_commission_qs_pct, contract.commissions?.fixed_commission_surplus_pct, worstLR.lr, contract.header?.country_id, td.countryId, contract, td.country_id, yearly, uwUserEdited]);

  // ── Component helpers ─────────────────────────────────────────────────────
  const getC = useCallback((row, col) => components[row]?.[col] || '', [components]);
  const setC = (row, col, val) => {
    setComponents(prev => ({ ...prev, [row]: { ...(prev[row] || {}), [col]: val } }));
    // A manual UW edit pins that row so the actuarial re-seed no longer overwrites it.
    if (col === 'uw') setUwUserEdited(prev => new Set([...prev, row]));
    setDirty(true);
  };

  const calcResult = useCallback((col) => {
    return 1 - parsePct(getC('Attritional Loss Ratio', col)) - parsePct(getC('Large Loss Loading', col))
      - parsePct(getC('Cat Loss Loading', col)) - parsePct(getC('Commissions', col))
      - parsePct(getC('Brokerage', col)) - parsePct(getC('Taxes', col));
  }, [getC]);

  const calcCR = useCallback((col) => {
    return parsePct(getC('Attritional Loss Ratio', col)) + parsePct(getC('Large Loss Loading', col))
      + parsePct(getC('Cat Loss Loading', col)) + parsePct(getC('Commissions', col))
      + parsePct(getC('Brokerage', col)) + parsePct(getC('Taxes', col));
  }, [getC]);

  const calcMaxComm = useCallback((col) => {
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

  // ── Share grid auto-fill ──────────────────────────────────────────────────
  useEffect(() => {
    if (!cid || loading) return;
    const cesPct = cn(td.cessionPct) || cn(det2.cession_pct) || 0;
    const cedantLimit = cesPct > 0 ? Math.round(limit / (cesPct / 100)) : '';
    const needs = k => { const v = shareGridRef.current?.['100%']?.[k]; return v == null || String(v).trim() === ''; };
    const crDownside = calcCR('downside');
    const downsideAmt100 = epi > 0 ? -Math.abs((crDownside - 1) * epi) : 0;
    const basePatch = {
      ...(needs('limit_amt') ? { limit_amt: String(Math.round(limit || 0)) } : {}),
      ...(needs('premium_amt') ? { premium_amt: String(Math.round(epi || 0)) } : {}),
      ...(needs('event_limit') ? { event_limit: String(Math.round(eventLimit || 0)) } : {}),
      ...(needs('cedant_limit') && cedantLimit ? { cedant_limit: String(cedantLimit) } : {}),
      downside_amt: String(Math.round(downsideAmt100)),
      ...(needs('shortfall_amt') ? { shortfall_amt: '0' } : {}),
    };
    if (Object.keys(basePatch).length) setShareGrid(prev => ({ ...prev, '100%': { ...(prev['100%'] || {}), ...basePatch } }));

    const countryId = hdr.country_id || td.countryId || td.country_id || '';
    let cancelled = false;
    (async () => {
      try {
        // Forward quote mode so quote-side contracts read from
        // quote_cresta_data instead of returning [] from the treaty path.
        const qm = appState.quoteMode ? { quote: true } : undefined;
        const crestaRows = await api.getCrestaData(cid, qm).catch(() => null);
        if (cancelled) return;
        const rows = Array.isArray(crestaRows) ? crestaRows : Array.isArray(crestaRows?.rows) ? crestaRows.rows : Array.isArray(crestaRows?.zones) ? crestaRows.zones : [];
        setContractAgg100(rows.reduce((sum, r) => sum + cn(r.eq_agg || 0) + cn(r.ws_agg || 0) + cn(r.flood_agg || 0) + cn(r.srcc_agg || 0) + cn(r.others_agg || 0), 0));
        if (countryId) {
          const cd = await api.getCountryAggregates(countryId, { excludeContractId: cid }).catch(() => null);
          if (!cancelled) setOtherCountryAgg(cn(cd?.total_country_agg ?? cd?.total_agg ?? 0));
        }
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [cid, loading, epi, limit, eventLimit, hdr.country_id, td.countryId, td.country_id, td.cessionPct, det2.cession_pct, calcCR, appState.quoteMode]);

  // ── Worst LR ─────────────────────────────────────────────────────────────
  // Loss-selection staleness — were large/cat losses edited after the last save?
  useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    api.getLossSelectionStaleness(cid, appState.quoteMode ? { quote: true } : undefined)
      .then(d => { if (!cancelled) setLossStale(!!d?.stale); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cid, appState.quoteMode]);

  useEffect(() => {
    if (!cid || loading) return;
    let cancelled = false;
    (async () => {
      try {
        const { rows } = await loadProjectedRows(cid, appState.quoteMode ? { quote: true } : undefined);
        if (cancelled || !rows?.length) return;
        let worst = null, year = '';
        for (const r of rows) { const p = r.actPrem || 0, l = r.actLoss || 0; if (p > 0) { const lr = l / p; if (worst === null || lr > worst) { worst = lr; year = String(r.year || ''); } } }
        if (!cancelled) setWorstLR({ lr: worst, year });
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [appState.quoteMode, cid, loading]);

  // ── FX / display helpers ──────────────────────────────────────────────────
  const safeCcy = currency;
  const displayCcy = showUSD && safeCcy !== 'USD' ? 'USD' : safeCcy;
  const toDisplay = n => { const v = Number(n); if (!Number.isFinite(v) || v === 0) return 0; return showUSD && safeCcy !== 'USD' ? v * fxRate : v; };
  const money = n => { const v = toDisplay(n); return v !== 0 ? `${displayCcy} ${fmt(Math.round(v))}` : '—'; };
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

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async (options = {}) => {
    if (!cid) return true;
    if (!loadedRef.current) return true; // don't overwrite DB before data has loaded
    const lockValue = options?.ifUnmodifiedSince || lastUpdatedAt;
    const compArr = COMPONENT_ROWS.map(name => ({
      component_name: name, actuarial_value: getC(name, 'actuarial'), uw_value: getC(name, 'uw'),
      market_value: getC(name, 'market'), actual_stats_value: getC(name, 'actual'),
      exposure_value: getC(name, 'exposure'), comment: getC(name, 'comment'),
    }));
    const payload = {
      contract_id: cid, components: compArr, leads,
      share_scenarios: shareRows.map(label => ({ share_label: label, ...(shareGrid[label] || {}) })),
      comment,
      outputs: {
        status: offerStatus, offer_line: offerLine, offer_comment: offerComment,
        offer_approver: offerApprover, signed_line_pct: signedLinePct,
        // EPI — total signed premium for region budget aggregation
        epi: epi || null,
        // Persist computed margins so cedant summary can read them relationally
        actuarial_margin: Number.isFinite(marginAct)       ? marginAct       : null,
        actual_margin:    Number.isFinite(1 - calcCR('actual')) ? 1 - calcCR('actual') : null,
        uw_margin:        Number.isFinite(marginUw)             ? marginUw         : null,
      },
    };
    const persist = (opts) => api.savePricingComposite(payload, opts);
    try {
      const response = await persist(lockValue ? { ifUnmodifiedSince: lockValue } : undefined);
      if (response?.updated_at) setLastUpdatedAt(response.updated_at);
      setDirty(false); setSaveMsg({ type: 'ok', text: 'Saved' }); setTimeout(() => setSaveMsg(null), 2000);
      return true;
    } catch (e) {
      console.error(e);
      const stale = await handleStaleWrite(e, {
        entityType: 'pricing',
        onRefresh: () => window.location.reload(),
        onOverwrite: async () => {
          const response = await persist({ ifUnmodifiedSince: '*' });
          if (response?.updated_at) setLastUpdatedAt(response.updated_at);
          setDirty(false);
          setSaveMsg({ type: 'ok', text: 'Saved' });
          setTimeout(() => setSaveMsg(null), 2000);
          return true;
        },
      });
      if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      setSaveMsg({ type: 'err', text: formatPricingDriftMessage(e) || 'Save failed' });
      setTimeout(() => setSaveMsg(null), 3000);
      return false;
    }
  }, [cid, lastUpdatedAt, leads, shareRows, comment, offerStatus, offerLine, offerComment, offerApprover, signedLinePct, epi, marginAct, calcCR, marginUw, getC, shareGrid]);

  // ── Snapshot handlers ─────────────────────────────────────────────────────
  const handleSaveSnapshot = async (label) => {
    if (!cid) return;
    const snapData = {};
    COMPONENT_ROWS.forEach(name => {
      snapData[name] = {};
      ['actuarial', 'actual', 'exposure', 'market', 'uw', 'downside', 'comment'].forEach(col => {
        const isCalc = name === 'Result' || name.includes('Maximum');
        snapData[name][col] = isCalc ? (name === 'Result' ? fmtPct(calcResult(col)) : fmtPct(calcMaxComm(col))) : getC(name, col);
      });
    });
    try {
      const saved = await api.saveComponentSnapshot(cid, { label: label || `Snapshot ${new Date().toLocaleDateString()}`, components: snapData });
      setSnapshots(prev => [saved, ...prev]);
      setSnapLabel('');
    } catch (e) { console.error('Snapshot save failed:', e); }
  };

  const handleDeleteSnapshot = async (snapId) => {
    try { await api.deleteComponentSnapshot(snapId); setSnapshots(prev => prev.filter(s => s.id !== snapId)); } catch (e) { console.error('deleteComponentSnapshot failed:', e); showToast('Failed to delete snapshot: ' + (e?.message || 'Server error')); }
  };

  // ── Workflow actions ──────────────────────────────────────────────────────
  const isTerminal = ['SIGNED', 'NTU', 'DECLINED'].includes(offerStatus);
  const isReadOnly = isTerminal;

  const doSubmitForApproval = async ({ peer1UserId, breachType, comment } = {}) => {
    if (!offerLine) { showToast('Enter a written line % first.'); return; }
    // offerApprover holds the selected user_id from the dropdown
    const selectedPeer = peer1UserId || offerApprover || null;
    if (!selectedPeer) { showToast('Please select who to send the offer to.'); return; }
    const ok = await save();
    if (!ok) { showToast('Cannot submit: the latest pricing failed to save. Retry save first.'); return; }
    try {
      await api.submitOfferForApproval(cid, {
        line_pct: offerLine, peer1_user_id: selectedPeer,
        breach_type: breachType || null, epi_usd: epi || null,
        comment: comment || offerComment, _actor: actorName,
      });
      setOfferStatusState('AWAITING_APPROVAL');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast(e.message || 'Failed to submit'); }
  };
  const doMarkApproved = async () => {
    const ok = await save();
    if (!ok) { showToast('Cannot approve: the latest pricing failed to save. Retry save first.'); return; }
    // Only advance UI state if the server actually accepted the
    // approval. The previous behaviour caught any error here and then
    // unconditionally advanced — leaving the local UI in APPROVED while
    // the contract on the server stayed in AWAITING_APPROVAL (or whatever
    // pre-approval state). The next save would then 422 because the
    // status machine on the server is the source of truth.
    try {
      await api.markOfferApproved(cid, { _actor: actorName, comment: returnReason || offerComment, line_pct: offerLine });
    } catch (e) {
      console.error('mark-approved error:', e.message);
      showToast('Approval failed: ' + (e?.message || 'Server error') + '. UI state unchanged — please retry.');
      return;
    }
    setOfferStatusState('AWAITING_SIGNED_LINE');
    setReturnReason('');
    api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  };
  const doMarkSigned = async () => {
    // Hard guard: reject empty / zero / non-numeric signed line
    // (belt-and-braces with the modal button's own check).
    const n = parseFloat(String(signedLinePct || '').replace(/%/g, '').trim());
    if (!Number.isFinite(n) || n <= 0) {
      showToast('Cannot mark signed: enter a non-zero signed line %.');
      return;
    }
    const w = parseFloat(String(offerLine || '').replace(/%/g, '').trim());
    if (Number.isFinite(w) && n > w) {
      showToast(`Signed line (${n}%) cannot exceed the written line (${w}%).`);
      return;
    }
    try {
      await api.markOfferSigned(cid, { signed_line_pct: signedLinePct, _actor: actorName });
      setOfferStatusState('SIGNED');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to mark signed: ' + (e?.message || 'Server error')); }
  };
  const doMarkNTU = async () => {
    try {
      await api.markOfferNTU(cid, { reason: returnReason || offerComment || '', _actor: actorName });
    } catch(e) { showToast('Failed to mark NTU: ' + (e?.message || 'Server error')); return; }
    setOfferStatusState('NTU');
    api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  };
  const doReturnToUW = async () => {
    if (!returnReason.trim()) { showToast('Please enter a reason for returning to the underwriter.'); return; }
    try {
      await api.returnToUnderwriter(cid, { reason: returnReason, _actor: actorName });
      setReturnReason(''); setOfferStatusState('DRAFT');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to return: ' + (e?.message || 'Server error')); }
  };
  const doRecall = async (reason) => {
    try {
      await api.recallOffer(cid, { reason: reason || 'Recalled by underwriter', _actor: actorName });
    } catch(e) { showToast('Recall failed: ' + (e?.message || 'Server error')); return; }
    setReturnReason('');
    setOfferStatusState('DRAFT');
    api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  };
  const doDecline = async () => {
    if (!window.confirm('Decline this treaty? This cannot be undone.')) return;
    const reason = returnReason.trim() || offerComment.trim() || 'Declined by Chief Underwriter';
    try {
      await api.declineContract(cid, reason, { body: { reason, _actor: actorName } });
      setOfferStatusState('DECLINED');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to decline: ' + (e?.message || 'Server error')); return; }
  };

  // ── CU decline triggered from offer modal ────────────────────────────────
  useEffect(() => {
    const handler = () => doDecline();
    window.addEventListener('prop-decline-from-cu', handler);
    return () => window.removeEventListener('prop-decline-from-cu', handler);
  });

  if (loading) return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="PROPORTIONAL TREATY: FINAL PRICING">
      {() => <div className="bbg-loading">Loading pricing data...</div>}
    </WizardLayout>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="PROPORTIONAL TREATY: FINAL PRICING" onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="PRICING_PAGE">

          {usedPlaceholderLdfs && (
            <div role="alert" style={{ margin: '0 0 12px', padding: '12px 16px', borderRadius: 10, background: 'rgba(249,115,22,0.14)', border: '2px solid #f97316', color: '#fdba74', fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
              No saved development factors found — projection is using placeholder benchmark curves. Go to the Development Factors screen to select and save factors before relying on these figures.
            </div>
          )}
          {lossStale && (
            <div role="alert" style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 10, background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.30)', color: '#fbbf24', fontSize: 12, lineHeight: 1.5 }}>
              Loss selection is outdated — losses have changed since the last selection was saved.
            </div>
          )}

          {/* ═══ BLOOMBERG HERO ═══ */}
          <PropBloombergHero
            drivers={drivers} balance={balance}
            safeCcy={safeCcy} displayCcy={displayCcy} showUSD={showUSD} fxLabel={fxLabel}
            setShowUSD={setShowUSD}
            uwYear={uwYear} offerStatus={offerStatus} treatyType={treatyType}
            tMode={tMode} isQS={isQS} isSurplus={isSurplus}
            qsLimit={qsLimit} retentionPct={retentionPct} retentionAmt={retentionAmt}
            surplusRetention={surplusRetention} numLines={numLines}
            totalCapacity={totalCapacity} combinedTotalLimit={combinedTotalLimit}
            epi={epi} eventLimit={eventLimit}
            commissionPctVal={commissionPctVal} profitCommPct={profitCommPct}
            mgmtExpPct={mgmtExpPct} taxesPctVal={taxesPctVal} brokeragePctVal={brokeragePctVal}
            crAct={crAct} crUw={crUw} marginAct={marginAct} marginUw={marginUw} worstLR={worstLR}
            toDisplay={toDisplay} money={money} cobLabel={cobLabel}
            epiSplit={contract.epi_split||td.epiSplit||[]} cobNames={cobLabel?cobLabel.split(', '):[]}
            cedant={cedant} country={country} broker={broker}
          />

          {/* ═══ LEAD & EXPIRING + INSIGHT BUTTONS ═══ */}
          <div className="bbg-top-grid">
            <div className="bbg-card">
              <div className="bbg-card-title">Lead & Expiring</div>
              <div className="bbg-lead-form">
                <div className="bbg-field"><span className="bbg-flabel">Lead Reinsurer</span>
                  <select className="bbg-select" value={leads.lead_reinsurer || ''} onChange={e => { setLeads(p => ({ ...p, lead_reinsurer: e.target.value })); setDirty(true); }}>
                    <option value="">Select leader…</option>
                    {reinsurers.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </select></div>
                <div className="bbg-field"><span className="bbg-flabel">Expiring Reinsurer</span>
                  <select className="bbg-select" value={leads.expiring_reinsurer || ''} onChange={e => { setLeads(p => ({ ...p, expiring_reinsurer: e.target.value })); setDirty(true); }}>
                    <option value="">Select expiring…</option>
                    {reinsurers.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </select></div>
                <div className="bbg-field"><span className="bbg-flabel">Lead Share %</span>
                  <PctInput className="bbg-input" value={leads.lead_share_pct || ''} onChange={v => { setLeads(p => ({ ...p, lead_share_pct: v })); setDirty(true); }} placeholder="e.g. 50%" /></div>
              </div>
            </div>
            <div className="bbg-card bbg-card--insights">
              <div className="bbg-card-title">Quick Actions & Insights</div>
              <div className="bbg-insight-grid bbg-insight-grid--5col">
                {INSIGHT_BUTTONS.map(b => (
                  <button key={b.key} className={`bbg-ib bbg-ib--${b.color}`} onClick={() => { setInsightKey(b.key); setInsightOpen(true); }}>{b.label}</button>
                ))}
              </div>
            </div>
          </div>

          {/* ═══ COMPONENT PRICING TABLE ═══ */}
          <PropComponentTable
            getC={getC} setC={setC}
            calcResult={calcResult} calcMaxComm={calcMaxComm}
            snapshots={snapshots} snapLabel={snapLabel} setSnapLabel={setSnapLabel}
            showSnapHistory={showSnapHistory} setShowSnapHistory={setShowSnapHistory}
            dirty={dirty} saveMsg={saveMsg} isReadOnly={isReadOnly}
            onSave={save} onSaveSnapshot={handleSaveSnapshot} onDeleteSnapshot={handleDeleteSnapshot}
            onShowQuickSummary={() => setShowQuickSummary(true)}
            onShowInDepth={() => setShowInDepth(true)}
            onShowMarketIntelligence={() => setShowMarketIntelligence(true)}
            marketIntelligenceAvailable={!!(
              (hdr.country_id || td.countryId || td.country_id)
              && (hdr.primary_class_of_business_id || td.primaryClassOfBusinessId)
              && Number.isFinite(Number(uwYear))
            )}
          />

          {/* ═══ QUICK SUMMARY MODAL ═══ */}
          {showQuickSummary && (
            <div className="bbg-modal-overlay" onClick={() => setShowQuickSummary(false)}>
              <div className="bbg-modal-full" onClick={e => e.stopPropagation()}>
                <div className="bbg-modal-head">
                  <span className="bbg-modal-title">Quick Summary</span>
                  <button className="bbg-modal-close" onClick={() => setShowQuickSummary(false)}>×</button>
                </div>
                <div className="bbg-modal-body"><QuickSummaryEmbed contractId={cid} /></div>
              </div>
            </div>
          )}

          {/* ═══ IN-DEPTH PORTFOLIO MODAL ═══ */}
          {showInDepth && (
            <InDepthPortfolioModal
              getC={getC}
              snapshots={snapshots}
              onClose={() => setShowInDepth(false)}
            />
          )}

          {/* ═══ SHARE SCENARIOS ═══ */}
          <PropShareScenarios
            shareRows={shareRows} setShareRows={setShareRows}
            shareGrid={shareGrid} setShareGrid={setShareGrid}
            contractAgg100={contractAgg100} otherCountryAgg={otherCountryAgg}
            toDisplay={toDisplay} setDirty={setDirty}
            onShowAggBreakdown={() => setShowAggBreakdown(true)}
            onShowAggDrilldown={() => setShowAggDrilldown(true)}
          />

          {/* ═══ AGG BREAKDOWN MODAL ═══ */}
          {showAggBreakdown && (
            <AggCobBreakdownModal
              contractId={cid} shareRows={shareRows}
              contractAgg100={contractAgg100} otherCountryAgg={otherCountryAgg}
              onClose={() => setShowAggBreakdown(false)}
            />
          )}

          {/* ═══ AGG DRILL-DOWN MODAL ═══ */}
          {showAggDrilldown && (
            <AggDrilldownModal
              contractId={cid}
              shareRows={shareRows}
              onClose={() => setShowAggDrilldown(false)}
            />
          )}

          {/* ═══ READ-ONLY BANNER ═══ */}
          {isReadOnly && (
            <div style={{ padding: '10px 16px', borderRadius: 10, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10,
              background: offerStatus === 'SIGNED' ? 'rgba(74,222,128,0.08)' : offerStatus === 'DECLINED' ? 'rgba(248,113,113,0.08)' : 'rgba(249,115,22,0.08)',
              border: `1px solid ${offerStatus === 'SIGNED' ? 'rgba(74,222,128,0.25)' : offerStatus === 'DECLINED' ? 'rgba(248,113,113,0.25)' : 'rgba(249,115,22,0.25)'}` }}>
              <span style={{ fontSize: 16 }}>{offerStatus === 'SIGNED' ? '✅' : offerStatus === 'DECLINED' ? '❌' : '🚫'}</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 13, color: offerStatus === 'SIGNED' ? '#4ade80' : offerStatus === 'DECLINED' ? '#f87171' : '#fb923c' }}>
                  Contract {offerStatus.replace(/_/g, ' ')} — Read Only
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 1 }}>
                  Pricing data is locked. Open the {offerStatus === 'SIGNED' || offerStatus === 'NTU' ? 'offer modal to review details' : 'offer modal to review this decision'}.
                </div>
              </div>
              <button className="bbg-btn" style={{ marginLeft: 'auto' }} onClick={() => setShowOffer(true)}>View Details →</button>
            </div>
          )}

          {/* ═══ DECISION BAR ═══ */}
          <div className="bbg-block bbg-block--decision">
            <div className="bbg-decision-grid">
              <div className="bbg-decision-comment">
                <span className="bbg-flabel">Underwriter Comment</span>
                <textarea className="bbg-textarea" rows={3} value={comment}
                  onChange={e => { if (!isReadOnly) { setComment(e.target.value); setDirty(true); } }}
                  placeholder="Pricing rationale…" readOnly={isReadOnly}
                  style={isReadOnly ? { opacity: 0.5, cursor: 'not-allowed' } : {}} />
              </div>
              <div className="bbg-decision-actions">
                <button
                  className="bbg-btn"
                  style={{ borderColor:'rgba(34,197,94,0.5)', color:'#4ade80', display:'flex', alignItems:'center', gap:6 }}
                  onClick={() => {
                    exportPropPricingToExcel({
                      cedantName: td?.cedantName || '',
                      countryName: td?.countryName || '',
                      uwYear: td?.startYear || td?.uwYear || '',
                      currency: td?.currencyCode || td?.currency || 'SAR',
                      treatyType: td?.treatyTypeName || td?.treatyType || '',
                      isQuote: !!appState.quoteMode,
                      components,
                      yearly,
                      epiSplit: (getC()?.epi_split || []),
                      shareRows,
                      shareGrid,
                      leads: leads && (leads.lead_reinsurer || leads.expiring_reinsurer)
                        ? [{ reinsurer_name: leads.lead_reinsurer, role: 'Lead', written_line_pct: leads.lead_share_pct },
                           leads.expiring_reinsurer ? { reinsurer_name: leads.expiring_reinsurer, role: 'Expiring', written_line_pct: null } : null
                          ].filter(Boolean)
                        : [],
                      comment,
                      totalEpi: cn(td?.quotaShareEpi || 0) + cn(td?.surplusEpi || 0),
                      qsEpi: cn(td?.quotaShareEpi || 0),
                      surplusEpi: cn(td?.surplusEpi || 0),
                    });
                  }}
                >↓ Export Excel</button>
                <button className="bbg-btn bbg-btn--offer" onClick={() => setShowOffer(true)}>
                  {isReadOnly ? 'View Offer' : offerStatus === 'AWAITING_APPROVAL' ? '⏳ Awaiting Approval' : offerStatus === 'AWAITING_SIGNED_LINE' ? '✍ Sign / NTU' : 'Offer Treaty'}
                </button>
                {!isReadOnly && offerStatus === 'DRAFT' && (
                  <button className="bbg-btn bbg-btn--decline" onClick={() => setShowDecline(true)}>Decline</button>
                )}
              </div>
            </div>
          </div>

          {/* ═══ DECLINE MODAL ═══ */}
          {showDecline && (
            <div className="bbg-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowDecline(false); }}>
              <div className="bbg-modal">
                <div className="bbg-modal-head"><span className="bbg-modal-title">Decline Treaty</span><button className="bbg-modal-x" onClick={() => setShowDecline(false)}>✕</button></div>
                <div className="bbg-modal-body">
                  <textarea className="bbg-textarea" rows={4} value={declineReason} onChange={e => setDeclineReason(e.target.value)} placeholder="Reason for declining…" />
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="bbg-btn bbg-btn--decline" onClick={async () => { try { await api.declineContract(cid, declineReason, { body: { reason: declineReason, _actor: actorName } }); } catch(e) { showToast('Decline failed: '+(e?.message||'Server error')); return; } setOfferStatusState('DECLINED'); setShowDecline(false); }}>Confirm Decline</button>
                    <button className="bbg-btn" onClick={() => setShowDecline(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            </div>
          )}


          {/* ═══ MANDATE BLOCK MODAL ═══ */}
          {showMandateBlock && mandateCheck && (
            <div className="bbg-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowMandateBlock(false); }}>
              <div className="bbg-modal" style={{ maxWidth: 520 }}>
                <div className="bbg-modal-head">
                  <span className="bbg-modal-title">⚠ Mandate Restriction</span>
                  <button className="bbg-modal-x" onClick={() => setShowMandateBlock(false)}>✕</button>
                </div>
                <div className="bbg-modal-body">
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginBottom: 12 }}>
                    This treaty cannot be offered under your current mandate:
                  </div>
                  {(mandateCheck.reasons || []).map((r, i) => (
                    <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', fontSize: 12, marginBottom: 8 }}>
                      {r}
                    </div>
                  ))}
                  <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                    Your role: <strong style={{ color: 'rgba(255,255,255,0.70)' }}>{userSession?.roleName || userRole}</strong>
                    {mandateCheck.mandate?.effectiveLimitUsd ? ` · Limit: USD ${(mandateCheck.mandate.effectiveLimitUsd / 1e6).toFixed(0)}M` : ' · Unlimited'}
                    {mandateCheck.resolvedEpiUsd ? ` · Treaty EPI: USD ${(mandateCheck.resolvedEpiUsd / 1e6).toFixed(1)}M` : ''}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                    <button className="bbg-btn" onClick={() => setShowMandateBlock(false)}>Close</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ═══ OFFER MODAL ═══ */}
          <PropOfferModal
            show={showOffer} onClose={() => setShowOffer(false)}
            offerStatus={offerStatus} offerLine={offerLine} setOfferLine={setOfferLine}
            offerComment={offerComment} setOfferComment={setOfferComment}
            offerApprover={offerApprover} setOfferApprover={setOfferApprover}
            returnReason={returnReason} setReturnReason={setReturnReason}
            signedLinePct={signedLinePct} setSignedLinePct={setSignedLinePct}
            approvalTrail={approvalTrail} actorName={actorName} isCU={isCU}
            isTerminal={isTerminal} marginAct={marginAct} marginUw={marginUw}
            crAct={crAct} crUw={crUw} epi={epi} limit={limit} eventLimit={eventLimit}
            fxInverse={fxInverse} safeCcy={safeCcy} money={money} aiCalc={aiCalc}
            contractId={cid} mandateCheck={mandateCheck}
            onSubmitForApproval={doSubmitForApproval}
            onMarkApproved={doMarkApproved} onReturnToUW={doReturnToUW}
            onMarkSigned={doMarkSigned} onMarkNTU={doMarkNTU} onDecline={doDecline} onRecall={doRecall}
            eligibleApprovers={eligibleApprovers}
            isQuote={!!appState.quoteMode}
          />

          {/* ═══ MARKET INTELLIGENCE MODAL ═══
              Trigger lives on the Component Pricing toolbar so the
              underwriter can review market context without entering
              the offer flow. */}
          <MarketIntelligenceModal
            show={showMarketIntelligence}
            onClose={() => setShowMarketIntelligence(false)}
            contractId={cid}
            countryId={hdr.country_id || td.countryId || td.country_id || null}
            classOfBusinessId={hdr.primary_class_of_business_id || td.primaryClassOfBusinessId || null}
            countryName={country}
            cobName={(cobLabel || '').split(',')[0]?.trim() || ''}
            targetYear={Number.isFinite(Number(uwYear)) ? Number(uwYear) : null}
            currency={safeCcy}
            treatyMetrics={{
              loss_ratio_pct: null,
              commission_pct: brokeragePctVal || null,
              retention_pct: cn(td.retentionPct) || cn(det2.retention_pct) || null,
              margin_pct: typeof marginAct === 'number' ? marginAct * 100 : null,
            }}
          />

          {/* ═══ INSIGHT MODAL ═══ */}
          {insightOpen && (
            <div className="bbg-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setInsightOpen(false); }}>
              <div className="bbg-modal bbg-modal--fullscreen">
                <div className="bbg-modal-head">
                  <span className="bbg-modal-title">{INSIGHT_BUTTONS.find(b => b.key === insightKey)?.label || insightKey}</span>
                  <button className="bbg-modal-x" onClick={() => setInsightOpen(false)}>✕</button>
                </div>
                <div className={['CHECKLIST','INTERNAL_METRICS','TREATY_METRICS','COMPARE_TERMS'].includes(insightKey) ? 'bbg-modal-body' : 'bbg-modal-body bbg-modal-body--embed'}>
                  {insightKey === 'CHECKLIST' && <ChecklistPanel contractId={cid} isQuote={!!appState.quoteMode} />}
                  {insightKey === 'INTERNAL_METRICS' && <InternalMetricsPanel contractId={cid} td={td} yearly={yearly} currency={safeCcy} />}
                  {insightKey === 'TREATY_METRICS' && <TreatyMetricsPanel shareGrid={shareGrid} contract={contract} td={td} epi={epi} limit={limit} yearly={yearly} contractId={cid} />}
                  {insightKey === 'COMPARE_TERMS' && <CompareTermsPanel contractId={cid} contract={contract} td={td} />}
                  {insightKey === 'CEDANT_SUMMARY' && <CedantSummaryTabs contractId={cid} currency={safeCcy} contract={contract} liveModelledMargin={marginAct} liveActualMargin={1 - calcCR('actual')} mode="PROP" />}
                  {insightKey === 'LARGE_LOSSES' && <div className="bbg-embed-screen"><LossSelectionScreen routeKey="PROP_LARGE_LOSS_SELECTION" title="Large Loss Selection" headerPill="" lossType="large" embedded /></div>}
                  {insightKey === 'CAT_LOSSES' && <div className="bbg-embed-screen"><LossSelectionScreen routeKey="PROP_CAT_LOSS_SELECTION" title="CAT Loss Selection" headerPill="" lossType="cat" embedded /></div>}
                  {insightKey === 'RISK_PROFILES' && <div className="bbg-embed-screen"><ProfileScreen routeKey="PROP_RISK_PROFILE" title="Risk Profile" headerPill="" profileType="risk" embedded /></div>}
                  {insightKey === 'CLAIMS_PROFILES' && <div className="bbg-embed-screen"><ProfileScreen routeKey="PROP_CLAIMS_PROFILE" title="Claims Profile" headerPill="" profileType="claims" embedded /></div>}
                  {insightKey === 'COUNTRY_AGG' && <div className="bbg-embed-screen"><PropCrestaAggregates embedded /></div>}
                </div>
              </div>
            </div>
          )}

          {/* ═══ MOVING AVERAGE CHARTS ═══ */}
          <PropMovingAverageCharts yearly={yearly} terms={movingAvgTerms} />

        </div>
      )}
    </WizardLayout>
  );
}
