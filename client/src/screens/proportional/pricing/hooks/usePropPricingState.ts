// hooks/usePropPricingState.ts — Phase 4.2 (docs/frontend-hardening.md).
//
// Owns ALL PropPricing state via useReducer(propPricingReducer) plus the
// screen's data loads, the giant auto-calc engine effect, the share-grid
// auto-fill effect and the save path. The effect bodies AND their
// dependency arrays (the reload contract) are the screen's originals
// moved VERBATIM — TS annotations only, zero runtime change — and the
// effects register in the original order: reset → eligible approvers →
// main load → approval trail → auto-calc → share auto-fill → loss
// staleness → worst LR → (usePropPricingActions) CU-decline listener.
// Every effect writes state through wrappers over the in-scope reducer
// `dispatch` declared inside the effect itself, so each dependency array
// stays exhaustive-deps clean exactly as it was on the screen (dispatch
// is hook-stable; everything else the bodies read is listed).
//
// Wire-format note: API payloads are handled as `any` at this boundary
// (the same dynamic shapes the untyped screen consumed); the STATE model
// in state/propPricingReducer.ts is the honestly-typed surface.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '../../../../api';
import { loadProjectedRows } from '../../../../logic/projectWithSavedFactors';
import { loadLossCategoryByYear, deriveLossComponents } from '../../../../logic/lossCategoryAmounts';
import { getRole, getUserDisplayName, getSession } from '../../../../utils/auth';
import { useGlobalToast } from '../../../../hooks/useToast';
import { handleStaleWrite as handleStaleWriteRaw } from '../../../../utils/handleStaleWrite';
import { isReadOnlyError } from '../../../../utils/readOnlyError';
import { formatPricingDriftMessage } from '../../../../utils/pricingErrors';
import {
  COMPONENT_ROWS, DEFAULT_SHARE_ROWS,
  cn, mbbefdG, SWISS_RE_C as SWISS_RE_C_RAW, fitPareto,
} from '../components/propPricingConstants.js';
import { paretoLayerExpectedLoss } from '../../../../utils/npPricingEngine';
import {
  propPricingReducer,
  createInitialPropPricingState,
} from '../state/propPricingReducer';
import type {
  GridSlice, WorkflowSlice, ModalsSlice, SaveLifecycleSlice, UiSlice, RefDataSlice,
  PropPricingAction, Setter, AnyRecord,
} from '../state/propPricingReducer';
import {
  normalizeStatus, buildFxRateMap, buildSavedShareGrid, buildHydratedComponents,
} from '../state/propPricingHydration';
import { usePropPricingDerived } from './usePropPricingDerived';
import { usePropPricingActions } from './usePropPricingActions.js';

// Typed bridges over untyped JS utility modules — the runtime references
// are unchanged, only the boundary types (the same pattern the np
// final_pricing reducer uses for shared/pricingMath).
// utils/handleStaleWrite.js destructures its options without JSDoc, so TS
// infers `{ entityType?: string }` and rejects onRefresh/onOverwrite.
const handleStaleWrite = handleStaleWriteRaw as unknown as (
  error: unknown,
  opts: { entityType?: string; onRefresh?: (p?: any) => any; onOverwrite?: (p?: any) => any },
) => Promise<{ handled: boolean; action?: string; result?: any }>;
// The Swiss Re curve map is indexed with a dynamic key from profile data.
const SWISS_RE_C: Record<string, number> = SWISS_RE_C_RAW;

/** Loose app-state bag from AppContext — wire-shaped, not state. */
export type AppStateLike = Record<string, any>;

export interface UsePropPricingStateParams {
  appState: AppStateLike;
  contractId: string | null | undefined;
  /**
   * Edit-lock verdict from useEditLock. When true (server said canEdit:false),
   * the save path is a no-op so wizard-nav / workflow saves stop POSTing into a
   * 403. Absent/undefined ⇒ editable (protects partially-migrated callers and
   * the golden-master fixtures, which never resolve a permission).
   */
  readOnly?: boolean;
  /** Called when a save comes back 403 READ_ONLY, to flip the UI read-only. */
  onServerReadOnly?: (assignedToName?: string | null) => void;
}

export function usePropPricingState({ appState, contractId, readOnly = false, onServerReadOnly }: UsePropPricingStateParams) {
  const [state, dispatch] = useReducer(propPricingReducer, undefined, createInitialPropPricingState);
  // Bumped by reloadPricing() to re-run the main load effect after a failure.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reloadPricing = useCallback(() => setReloadNonce((n) => n + 1), []);

  const {
    grid: { components, uwUserEdited, leads, shareRows, shareGrid, yearly, comment, snapshots, snapLabel },
    workflow: {
      offerStatus, offerLine, offerComment, offerApprover, eligibleApprovers,
      returnReason, declineReason, approvalTrail, signedLinePct,
    },
    modals: {
      showDecline, showOffer, showMandateBlock, showQuickSummary, showMarketIntelligence,
      showAggBreakdown, showInDepth, showAggDrilldown, showSnapHistory, insightOpen, insightKey,
    },
    saveLifecycle: { dirty, saveMsg, lastUpdatedAt },
    ui: { loading, showUSD, error },
    refData: {
      contract, reinsurers, fxRates, contractAgg100, otherCountryAgg,
      cobLabel, worstLR, usedPlaceholderLdfs, lossStale,
    },
  } = state;

  const loadedRef = useRef(false);
  const userRole = useMemo(() => getRole(), []);
  const userSession = useMemo(() => getSession(), []);
  // CE, CU, TD, TM can all approve (hierarchy_level <= 4)
  const isCU = getRole() === 'CU' || getRole() === 'CE'; // only CU/CE see the approver panel
  const actorName = useMemo(() => getUserDisplayName(), []);
  const showToast = useGlobalToast();
  const mandateCheck = null;

  const td = useMemo(() => appState.propTreatyDetail || {}, [appState.propTreatyDetail]);
  const cid = contractId || td.contractId;

  // ── Stable setter bundle (useState-compatible call signatures) ───────────
  const setters = useMemo(() => {
    const gridSet = <K extends keyof GridSlice & string>(key: K) =>
      (next: Setter<GridSlice[K]>) => dispatch({ type: 'grid/set', key, next } as PropPricingAction);
    const workflowSet = <K extends keyof WorkflowSlice & string>(key: K) =>
      (next: Setter<WorkflowSlice[K]>) => dispatch({ type: 'workflow/set', key, next } as PropPricingAction);
    const modalsSet = <K extends keyof ModalsSlice & string>(key: K) =>
      (next: Setter<ModalsSlice[K]>) => dispatch({ type: 'modals/set', key, next } as PropPricingAction);
    const saveSet = <K extends keyof SaveLifecycleSlice & string>(key: K) =>
      (next: Setter<SaveLifecycleSlice[K]>) => dispatch({ type: 'saveLifecycle/set', key, next } as PropPricingAction);
    const uiSet = <K extends keyof UiSlice & string>(key: K) =>
      (next: Setter<UiSlice[K]>) => dispatch({ type: 'ui/set', key, next } as PropPricingAction);
    return {
      setComponents: gridSet('components'),
      setUwUserEdited: gridSet('uwUserEdited'),
      setLeads: gridSet('leads'),
      setShareRows: gridSet('shareRows'),
      setShareGrid: gridSet('shareGrid'),
      setComment: gridSet('comment'),
      setSnapshots: gridSet('snapshots'),
      setSnapLabel: gridSet('snapLabel'),
      setOfferStatusState: workflowSet('offerStatus'),
      setOfferLine: workflowSet('offerLine'),
      setOfferComment: workflowSet('offerComment'),
      setOfferApprover: workflowSet('offerApprover'),
      setReturnReason: workflowSet('returnReason'),
      setDeclineReason: workflowSet('declineReason'),
      setApprovalTrail: workflowSet('approvalTrail'),
      setSignedLinePct: workflowSet('signedLinePct'),
      setShowDecline: modalsSet('showDecline'),
      setShowOffer: modalsSet('showOffer'),
      setShowMandateBlock: modalsSet('showMandateBlock'),
      setShowQuickSummary: modalsSet('showQuickSummary'),
      setShowMarketIntelligence: modalsSet('showMarketIntelligence'),
      setShowAggBreakdown: modalsSet('showAggBreakdown'),
      setShowInDepth: modalsSet('showInDepth'),
      setShowAggDrilldown: modalsSet('showAggDrilldown'),
      setShowSnapHistory: modalsSet('showSnapHistory'),
      setInsightOpen: modalsSet('insightOpen'),
      setInsightKey: modalsSet('insightKey'),
      setDirty: saveSet('dirty'),
      setShowUSD: uiSet('showUSD'),
    };
  }, [dispatch]);
  const { setComponents, setUwUserEdited, setDirty } = setters;

  // ── Reset when contract changes ──────────────────────────────────────────
  const prevCidRef = useRef(cid);
  useEffect(() => {
    if (prevCidRef.current !== cid) {
      prevCidRef.current = cid;
      // One transition that applies the legacy effect's exact setter list.
      dispatch({ type: 'contract/reset' });
    }
  }, [cid]);

  // ── Load eligible approvers for the offer dropdown ─────────────────────
  useEffect(() => {
    const setEligibleApprovers = (next: any) => dispatch({ type: 'workflow/set', key: 'eligibleApprovers', next });
    if (!cid) return;
    api.getEligibleApprovers(cid, {}).then(rows => {
      setEligibleApprovers(Array.isArray(rows) ? rows : []);
    }).catch(() => {});
  }, [cid]);

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const setLoading = (next: any) => dispatch({ type: 'ui/set', key: 'loading', next });
    const setError = (next: any) => dispatch({ type: 'ui/set', key: 'error', next });
    const setContract = (next: any) => dispatch({ type: 'refData/set', key: 'contract', next });
    const setReinsurers = (next: any) => dispatch({ type: 'refData/set', key: 'reinsurers', next });
    const setLastUpdatedAt = (next: any) => dispatch({ type: 'saveLifecycle/set', key: 'lastUpdatedAt', next });
    const setYearly = (next: any) => dispatch({ type: 'grid/set', key: 'yearly', next });
    const setSnapshots = (next: any) => dispatch({ type: 'grid/set', key: 'snapshots', next });
    const setFxRates = (next: any) => dispatch({ type: 'refData/set', key: 'fxRates', next });
    const setLeads = (next: any) => dispatch({ type: 'grid/set', key: 'leads', next });
    const setShareRows = (next: any) => dispatch({ type: 'grid/set', key: 'shareRows', next });
    const setShareGrid = (next: any) => dispatch({ type: 'grid/set', key: 'shareGrid', next });
    const setComponents = (next: any) => dispatch({ type: 'grid/set', key: 'components', next });
    const setOfferStatusState = (next: any) => dispatch({ type: 'workflow/set', key: 'offerStatus', next });
    const setComment = (next: any) => dispatch({ type: 'grid/set', key: 'comment', next });
    const setOfferLine = (next: any) => dispatch({ type: 'workflow/set', key: 'offerLine', next });
    const setOfferComment = (next: any) => dispatch({ type: 'workflow/set', key: 'offerComment', next });
    const setOfferApprover = (next: any) => dispatch({ type: 'workflow/set', key: 'offerApprover', next });
    const setSignedLinePct = (next: any) => dispatch({ type: 'workflow/set', key: 'signedLinePct', next });
    const setShowOffer = (next: any) => dispatch({ type: 'modals/set', key: 'showOffer', next });

    if (!cid) { setLoading(false); return; }
    setError(null);
    // The two CORE fetches (contract + pricing) are NOT swallowed: a real
    // failure must surface as a retry panel rather than silently rendering a
    // blank pricing screen the user could save over real data. The auxiliary
    // fetches stay best-effort (an empty reinsurer/FX/snapshot list is benign).
    Promise.all([
      api.getContract(cid),
      api.getPricing(cid),
      api.listReinsurers().catch(() => []),
      api.getPricingYearly(cid).catch(() => []),
      api.getExchangeRates().catch(() => []),
      api.getComponentSnapshots(cid).catch(() => []),
    ]).then(([c, p, r, y, rates, snaps]: any[]) => {
      const hdr = c?.header || c || {};
      setContract(c || {}); setReinsurers(Array.isArray(r) ? r : []);
      setLastUpdatedAt(hdr.updated_at || c?.updated_at || null);
      setYearly(Array.isArray(y) ? y : []);
      setSnapshots(Array.isArray(snaps) ? snaps : []);

      setFxRates(buildFxRateMap(rates));

      if (p.leads) setLeads(p.leads);
      if (p.share_scenarios?.length) {
        // Always use the canonical 4 rows — never append user-typed label accidents.
        // Map saved data into the default rows by label; ignore any extras.
        setShareRows(DEFAULT_SHARE_ROWS.slice());
        setShareGrid(buildSavedShareGrid(p));
      }

      // Saved component rows + the Commissions/Brokerage/Taxes seed
      // (state/propPricingHydration.ts — the original block verbatim).
      setComponents(buildHydratedComponents(p, c, td));

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
    }).catch(e => { console.error('Pricing load failed:', e); setError(e); setLoading(false); });
  }, [cid, td.brokeragePct, td.commissionMode, td.fixedCommissionQSPct, td.fixedCommissionSurplusPct, td.provisionalCommissionPct, td.quotaShareEpi, td.surplusEpi, td.taxesPct, reloadNonce]);

  useEffect(() => {
    const setApprovalTrail = (next: any) => dispatch({ type: 'workflow/set', key: 'approvalTrail', next });
    if (cid) api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  }, [cid]);

  // ── Auto-calculate actuarial / actual / market / downside columns ─────────
  useEffect(() => {
    const setComponents = (next: any) => dispatch({ type: 'grid/set', key: 'components', next });
    const setUsedPlaceholderLdfs = (next: any) => dispatch({ type: 'refData/set', key: 'usedPlaceholderLdfs', next });
    const setCobLabel = (next: any) => dispatch({ type: 'refData/set', key: 'cobLabel', next });

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
    const fmtV = (val: any) => typeof val === 'number' ? `${(val * 100).toFixed(2)}%` : val;

    setComponents((prev: any) => {
      const nc = { ...prev };
      const force = (row: string, col: string, val: any) => { if (!nc[row]) nc[row] = {}; nc[row] = { ...nc[row], [col]: fmtV(val) }; };
      force('Commissions', 'actuarial', commissionPct); force('Brokerage', 'actuarial', brokeragePct); force('Taxes', 'actuarial', taxesPct);
      force('Commissions', 'actual', commissionPct); force('Brokerage', 'actual', brokeragePct); force('Taxes', 'actual', taxesPct);
      return nc;
    });

    (async () => {
      try {
        const projectedLRs: number[] = [], actualLRs: number[] = [];
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
        const proj: any = await loadProjectedRows(cid, appState.quoteMode ? { quote: true } : undefined);
        setUsedPlaceholderLdfs(!!proj.usedPlaceholderLdfs);
        if (!projectedLRs.length) {
          (proj.rows || []).forEach((r: any) => {
            if (r.ultPrem > 0) { projectedLRs.push(r.ultLoss / r.ultPrem); totProjLoss += r.ultLoss; totProjPrem += r.ultPrem; }
            if (r.actPrem > 0) { actualLRs.push(r.actLoss / r.actPrem); totActLoss += r.actLoss; totActPrem += r.actPrem; }
          });
        }
        const avgActualLR = actualLRs.length ? actualLRs.reduce((a, b) => a + b, 0) / actualLRs.length : 0;
        const avgProjectedLR = projectedLRs.length ? projectedLRs.reduce((a, b) => a + b, 0) / projectedLRs.length : avgActualLR;

        // Large/CAT totals (raw incurred) and the per-treaty strip flag.
        const lossCat = await loadLossCategoryByYear(cid, appState.quoteMode ? { quote: true } : undefined)
          .catch(() => ({ large: new Map(), cat: new Map() }));
        const totalLarge = [...lossCat.large.values()].reduce((a: number, b: any) => a + b, 0);
        const totalCat = [...lossCat.cat.values()].reduce((a: number, b: any) => a + b, 0);
        const stripLC = (det.strip_large_cat_losses ?? td.stripLargeCat ?? false) !== false;
        // Attritional on each basis via the shared loss-component model.
        // Actuarial uses projected totals; actual uses unprojected (raw) totals.
        const projComp = deriveLossComponents({ premium: totProjPrem, incurredTotal: totProjLoss, large: stripLC ? totalLarge : 0, cat: stripLC ? totalCat : 0 });
        const actComp = deriveLossComponents({ premium: totActPrem, incurredTotal: totActLoss, large: totalLarge, cat: totalCat });
        const actuarialAttrLR = totProjPrem > 0 ? projComp.attrLR : avgProjectedLR;
        const actualAttrLR = totActPrem > 0 ? actComp.attrLR : avgActualLR;

        let largeLossLoad = 0;
        try {
          const llSnap: any = await api.getLossSelectionLatest(cid, 'large').catch(() => ({}));
          const snap = llSnap?.snapshot || {};
          const savedAlpha = cn(snap.pareto_alpha);
          const savedXm    = cn(snap.pareto_xm);
          const savedYears = cn(snap.observation_years);
          const savedN     = cn(snap.selected_count);
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
            const rawLL: any = await api.getLargeLosses(cid).catch(() => []);
            const losses = (rawLL?.losses || rawLL || [])
              .map((l: any) => cn(l.incurred || l.paid) + cn(l.os))
              .filter((v: any) => v > 0);
            if (losses.length >= 3 && treatyCapacity > 0 && effEpi > 0) {
              const sorted = [...losses].sort((a, b) => a - b);
              const xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
              const { alpha, n } = fitPareto(losses, xm);
              const years = Math.max(5, new Set(
                (rawLL?.losses || rawLL || []).map((l: any) => l.uw_year)
              ).size);
              if (alpha > 1 && treatyCapacity > xm) {
                largeLossLoad = paretoLayerExpectedLoss(
                  alpha, xm, xm, treatyCapacity - xm, n, years
                ) / effEpi;
              }
            }
          }
        } catch (e) { console.error('Large loss load calc failed:', e); }

        let catLoad = 0;
        try {
          const catSnap: any = await api.getLossSelectionLatest(cid, 'cat').catch(() => ({}));
          const snap = catSnap?.snapshot || {};
          const savedAlpha = cn(snap.pareto_alpha);
          const savedXm    = cn(snap.pareto_xm);
          const savedYears = cn(snap.observation_years);
          const savedN     = cn(snap.selected_count);
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
            const rawCat: any = await api.getCatLosses(cid).catch(() => []);
            const losses = (rawCat?.losses || rawCat || [])
              .map((l: any) => cn(l.incurred || l.paid) + cn(l.os))
              .filter((v: any) => v > 0);
            if (losses.length >= 3 && catCap > 0 && effEpi > 0) {
              const sorted = [...losses].sort((a, b) => a - b);
              const xm = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
              const { alpha, n } = fitPareto(losses, xm);
              const years = Math.max(5, new Set(
                (rawCat?.losses || rawCat || []).map((l: any) => l.uw_year)
              ).size);
              if (alpha > 1 && catCap > xm) {
                catLoad = paretoLayerExpectedLoss(
                  alpha, xm, xm, catCap - xm, n, years
                ) / effEpi;
              }
            }
          }
        } catch (e) { console.error('Cat load calc failed:', e); }

        let exposureLR = 0;
        let cobIds: any[] = [];
        try {
          const cobsRes: any = await api.getContractCobs(cid).catch(() => []);
          const cobRows = cobsRes?.rows || cobsRes || [];
          const cobList = cobRows.map((x: any) => x.cob_id || x.id || x.class_of_business_id);
          cobIds = cobRows.map((x: any) => x.class_of_business_id || x.cob_id || x.id).filter(Boolean);
          const cobNames = cobRows.map((x: any) => x.name || x.cob_name || x.class_of_business || '').filter(Boolean);
          if (cobNames.length) setCobLabel(cobNames.join(', '));
          let totalExpLoss = 0;
          for (const cobId of cobList) {
            if (!cobId) continue;
            const rp: any = await api.getRiskProfile(cid, cobId).catch(() => ({}));
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

        let marketAvg: any = {};
        try {
          const hdrDetail = contract?.header || contract || {};
          const treatyTypeId = hdrDetail.treaty_type_id || td.treatyTypeId || null;
          const countryId = hdrDetail.country_id || td.countryId || td.country_id || '';
          const countryData: any = countryId ? await api.getCountry(countryId).catch(() => ({})) : {};
          const region = countryData?.region || null;
          if (countryId) {
            marketAvg = await api.getMarketAverage(countryId, cid, { treatyTypeId, cobIds, region }).catch(() => ({}));
          }
        } catch (e) {}

        setComponents((prev: any) => {
          const nc = { ...prev };
          const sc = (row: string, col: string, val: any) => { if (!nc[row]) nc[row] = {}; nc[row] = { ...nc[row], [col]: fmtV(val) }; };
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
          const mktSet = (row: string, val: any) => { const n = Number(val); if (val != null && Number.isFinite(n)) sc(row, 'market', n); };
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
  }, [appState.quoteMode, cid, loading, yearly.length, td.treatyTypeId, td.quotaShareEpi, td.surplusEpi, td.fixedCommissionQSPct, td.fixedCommissionSurplusPct, td.brokeragePct, td.taxesPct, td.provisionalCommissionPct, td.commissionMode, td.stripLargeCat, td.totalCapacity, td.qsLimit, td.eventLimit, contract.detail?.total_capacity, contract.detail?.qs_limit, contract.detail?.event_limit, contract.detail?.brokerage_pct, contract.detail?.taxes_pct, contract.commissions?.fixed_commission_qs_pct, contract.commissions?.fixed_commission_surplus_pct, worstLR.lr, contract.header?.country_id, td.countryId, contract, td.country_id, yearly, uwUserEdited]);

  // ── Component helpers ─────────────────────────────────────────────────────
  const setC = (row: string, col: string, val: any) => {
    setComponents(prev => ({ ...prev, [row]: { ...(prev[row] || {}), [col]: val } }));
    // A manual UW edit pins that row so the actuarial re-seed no longer overwrites it.
    if (col === 'uw') setUwUserEdited(prev => new Set([...prev, row]));
    setDirty(true);
  };

  // getC, the combined-ratio calculators, the treaty-level derived values,
  // FX/display helpers, hero drivers and the AI line suggestion — moved
  // verbatim into hooks/usePropPricingDerived.ts (pure derivation, no effects).
  const derived = usePropPricingDerived({ contract, td, components, fxRates, showUSD });
  const { getC, calcResult, calcCR, calcMaxComm, hdr, det2, epi, limit, eventLimit, marginAct, marginUw } = derived;

  const shareGridRef = useRef(shareGrid);
  shareGridRef.current = shareGrid;

  // ── Share grid auto-fill ──────────────────────────────────────────────────
  useEffect(() => {
    const setShareGrid = (next: any) => dispatch({ type: 'grid/set', key: 'shareGrid', next });
    const setContractAgg100 = (next: any) => dispatch({ type: 'refData/set', key: 'contractAgg100', next });
    const setOtherCountryAgg = (next: any) => dispatch({ type: 'refData/set', key: 'otherCountryAgg', next });

    if (!cid || loading) return;
    const cesPct = cn(td.cessionPct) || cn(det2.cession_pct) || 0;
    const cedantLimit = cesPct > 0 ? Math.round(limit / (cesPct / 100)) : '';
    const needs = (k: string) => { const v = shareGridRef.current?.['100%']?.[k]; return v == null || String(v).trim() === ''; };
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
    if (Object.keys(basePatch).length) setShareGrid((prev: any) => ({ ...prev, '100%': { ...(prev['100%'] || {}), ...basePatch } }));

    const countryId = hdr.country_id || td.countryId || td.country_id || '';
    let cancelled = false;
    (async () => {
      try {
        // Forward quote mode so quote-side contracts read from
        // quote_cresta_data instead of returning [] from the treaty path.
        const qm = appState.quoteMode ? { quote: true } : undefined;
        const crestaRows: any = await api.getCrestaData(cid, qm).catch(() => null);
        if (cancelled) return;
        const rows = Array.isArray(crestaRows) ? crestaRows : Array.isArray(crestaRows?.rows) ? crestaRows.rows : Array.isArray(crestaRows?.zones) ? crestaRows.zones : [];
        setContractAgg100(rows.reduce((sum: number, r: any) => sum + cn(r.eq_agg || 0) + cn(r.ws_agg || 0) + cn(r.flood_agg || 0) + cn(r.srcc_agg || 0) + cn(r.others_agg || 0), 0));
        if (countryId) {
          const cd: any = await api.getCountryAggregates(countryId, { excludeContractId: cid }).catch(() => null);
          if (!cancelled) setOtherCountryAgg(cn(cd?.total_country_agg ?? cd?.total_agg ?? 0));
        }
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [cid, loading, epi, limit, eventLimit, hdr.country_id, td.countryId, td.country_id, td.cessionPct, det2.cession_pct, calcCR, appState.quoteMode]);

  // ── Worst LR ─────────────────────────────────────────────────────────────
  // Loss-selection staleness — were large/cat losses edited after the last save?
  useEffect(() => {
    const setLossStale = (next: any) => dispatch({ type: 'refData/set', key: 'lossStale', next });
    if (!cid) return;
    let cancelled = false;
    api.getLossSelectionStaleness(cid, appState.quoteMode ? { quote: true } : undefined)
      .then((d: any) => { if (!cancelled) setLossStale(!!d?.stale); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cid, appState.quoteMode]);

  useEffect(() => {
    const setWorstLR = (next: any) => dispatch({ type: 'refData/set', key: 'worstLR', next });
    if (!cid || loading) return;
    let cancelled = false;
    (async () => {
      try {
        const { rows } = await loadProjectedRows(cid, appState.quoteMode ? { quote: true } : undefined);
        if (cancelled || !rows?.length) return;
        let worst: number | null = null, year = '';
        for (const r of rows) { const p = r.actPrem || 0, l = r.actLoss || 0; if (p > 0) { const lr = l / p; if (worst === null || lr > worst) { worst = lr; year = String(r.year || ''); } } }
        if (!cancelled) setWorstLR({ lr: worst, year });
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [appState.quoteMode, cid, loading]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async (options: any = {}) => {
    const setLastUpdatedAt = (next: any) => dispatch({ type: 'saveLifecycle/set', key: 'lastUpdatedAt', next });
    const setDirty = (next: any) => dispatch({ type: 'saveLifecycle/set', key: 'dirty', next });
    const setSaveMsg = (next: any) => dispatch({ type: 'saveLifecycle/set', key: 'saveMsg', next });

    if (!cid) return true;
    // Read-only (not the assignee): never POST. Returning true is a no-op that
    // lets wizard navigation proceed without writing — the server would 403 this
    // (READ_ONLY) and the inert UI already blocks manual edits.
    if (readOnly) return true;
    if (!loadedRef.current) return true; // don't overwrite DB before data has loaded
    const lockValue = options?.ifUnmodifiedSince || lastUpdatedAt;
    const compArr = COMPONENT_ROWS.map((name: string) => ({
      component_name: name, actuarial_value: getC(name, 'actuarial'), uw_value: getC(name, 'uw'),
      market_value: getC(name, 'market'), actual_stats_value: getC(name, 'actual'),
      exposure_value: getC(name, 'exposure'), comment: getC(name, 'comment'),
    }));
    // downside_amt is normally written into the grid by the auto-fill
    // effect, which lands one render after the component grid settles — a
    // save in that window would persist a stale figure. Recompute it here
    // from the live components (same formula as the effect) so the saved
    // 100% scenario always matches the displayed table.
    const crDownsideNow = calcCR('downside');
    const downsideAmtNow = epi > 0 ? -Math.abs((crDownsideNow - 1) * epi) : 0;
    const payload = {
      contract_id: cid, components: compArr, leads,
      share_scenarios: shareRows.map(label => {
        const row: AnyRecord = { share_label: label, ...(shareGrid[label] || {}) };
        if (label === '100%') row.downside_amt = String(Math.round(downsideAmtNow));
        return row;
      }),
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
    const persist = (opts?: any): Promise<any> => api.savePricingComposite(payload, opts);
    try {
      const response = await persist(lockValue ? { ifUnmodifiedSince: lockValue } : undefined);
      if (response?.updated_at) setLastUpdatedAt(response.updated_at);
      setDirty(false); setSaveMsg({ type: 'ok', text: 'Saved' }); setTimeout(() => setSaveMsg(null), 2000);
      return true;
    } catch (e) {
      console.error(e);
      // Not the assignee: the lock raced this write (or failed open). Flip the
      // editor read-only, surface it once, and STOP — never retry/overwrite an
      // authz verdict. The banner's "Allocate to me" is the path back to edit.
      if (isReadOnlyError(e)) {
        onServerReadOnly?.();
        setSaveMsg({ type: 'err', text: 'Read-only — this treaty is assigned to someone else. Claim it (if unassigned) or have it allocated to you to edit.' });
        setTimeout(() => setSaveMsg(null), 4000);
        return true; // no-op for nav: don't block, don't retry
      }
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
  }, [cid, readOnly, onServerReadOnly, lastUpdatedAt, leads, shareRows, comment, offerStatus, offerLine, offerComment, offerApprover, signedLinePct, epi, marginAct, calcCR, marginUw, getC, shareGrid]);

  // Snapshot handlers + offer workflow + the CU-decline listener (the last
  // effect to register, as on the original screen).
  const actions = usePropPricingActions({
    cid, actorName, showToast, save,
    getC, calcResult, calcMaxComm, epi,
    offerStatus, offerLine, offerComment, offerApprover, returnReason, signedLinePct,
    setSnapshots: setters.setSnapshots,
    setSnapLabel: setters.setSnapLabel,
    setOfferStatusState: setters.setOfferStatusState,
    setApprovalTrail: setters.setApprovalTrail,
    setReturnReason: setters.setReturnReason,
  });

  return {
    // identity / context
    td, cid, userRole, userSession, isCU, actorName, showToast, mandateCheck,
    // raw state
    loading, error, reloadPricing, dirty, saveMsg, lastUpdatedAt, contract, components, uwUserEdited,
    leads, shareRows, shareGrid, yearly, comment, snapshots, snapLabel,
    offerStatus, offerLine, offerComment, offerApprover, eligibleApprovers,
    returnReason, declineReason, approvalTrail, signedLinePct,
    showDecline, showOffer, showMandateBlock, showQuickSummary, showMarketIntelligence,
    showAggBreakdown, showInDepth, showAggDrilldown, showSnapHistory, insightOpen, insightKey,
    showUSD, fxRates, reinsurers, contractAgg100, otherCountryAgg, cobLabel,
    worstLR, usedPlaceholderLdfs, lossStale,
    // setters
    ...setters,
    // grid edit helper + derived pricing surface
    setC,
    ...derived,
    // save + snapshots + offer workflow
    save,
    ...actions,
  };
}

export type PropPricingStateApi = ReturnType<typeof usePropPricingState>;
export default usePropPricingState;
