// hooks/useNpPricingState.ts — Phase 4.1 (docs/frontend-hardening.md).
//
// Owns ALL NpFinalPricing state via useReducer(pricingReducer) plus the
// screen's data loads and derived-recompute effects. The effect bodies
// (and their dependency arrays — the reload contract) are the screen's
// originals moved VERBATIM; hydration ordering inside each then-block is
// unchanged, and each load keeps its own cancelled flag exactly as
// before. They are deliberately NOT rebuilt on useResource in this
// stage: these loads hydrate a dozen-plus state keys with strict
// internal ordering and two of them re-run on derived string keys —
// reproducing that on the generic primitive risks behaviour drift for
// no functional gain while the golden master must stay byte-identical.
//
// Wire-format note: API payloads are handled as `any` at this boundary
// (the same dynamic shapes the untyped screen consumed); the STATE
// model in state/pricingReducer.ts is the honestly-typed surface.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { api } from '../../../../api';
import { toN } from '../formatters.js';
import { fqBuildPricingCurve } from '../fqHelpers.js';
import { useNpPricingLoads } from './useNpPricingLoads';
import {
  pricingReducer,
  createInitialPricingState,
  num,
  fmtPct,
  layerIdx,
} from '../state/pricingReducer';
import type {
  NpPricingState,
  PricingAction,
  Setter,
  LayersSlice,
  FqSlice,
  WorkflowSlice,
  ModalsSlice,
  UiSlice,
  RefDataSlice,
  LayerPricing,
  LooseRecord,
  QuoteStructureDraft,
  EngineLayerResult,
  PerilDefaults,
} from '../state/pricingReducer';

/** Loose treaty-detail bag from AppContext — wire-shaped, not state. */
export type NpDetailLike = Record<string, any>;

export interface UseNpPricingStateParams {
  contractId: string;
  quoteMode: boolean;
  isQuote: boolean;
  npDetail: NpDetailLike;
  /** appState.npTreatyDetail?.countryId — dep of the country-agg load. */
  countryId: string | null;
  mode: string;
  riskDisabled: boolean;
  catDisabled: boolean;
  /** Structure layers synced from NpStructure via AppContext. */
  structureLayers: LooseRecord[];
}

export function useNpPricingState({
  contractId,
  quoteMode,
  isQuote,
  npDetail,
  countryId,
  mode,
  riskDisabled,
  catDisabled,
  structureLayers,
}: UseNpPricingStateParams) {
  const [state, dispatch] = useReducer(pricingReducer, undefined, createInitialPricingState);

  // ── Stable setter bundle (useState-compatible call signatures) ─────────
  const setters = useMemo(() => {
    const layersSet = <K extends keyof LayersSlice & string>(key: K) =>
      (next: Setter<LayersSlice[K]>) => dispatch({ type: 'layers/set', key, next } as PricingAction);
    const fqSet = <K extends keyof FqSlice & string>(key: K) =>
      (next: Setter<FqSlice[K]>) => dispatch({ type: 'fq/set', key, next } as PricingAction);
    const workflowSet = <K extends keyof WorkflowSlice & string>(key: K) =>
      (next: Setter<WorkflowSlice[K]>) => dispatch({ type: 'workflow/set', key, next } as PricingAction);
    const modalsSet = <K extends keyof ModalsSlice & string>(key: K) =>
      (next: Setter<ModalsSlice[K]>) => dispatch({ type: 'modals/set', key, next } as PricingAction);
    const uiSet = <K extends keyof UiSlice & string>(key: K) =>
      (next: Setter<UiSlice[K]>) => dispatch({ type: 'ui/set', key, next } as PricingAction);
    const refDataSet = <K extends keyof RefDataSlice & string>(key: K) =>
      (next: Setter<RefDataSlice[K]>) => dispatch({ type: 'refData/set', key, next } as PricingAction);
    return {
      setLayers: layersSet('layers'),
      setLeadSetup: layersSet('leadSetup'),
      setLocalStructureLayers: layersSet('localStructureLayers'),
      setTreatyMetrics: layersSet('treatyMetrics'),
      setCobUwLimits: layersSet('cobUwLimits'),
      setExpiringEgnpi: layersSet('expiringEgnpi'),
      setExpLayers: fqSet('expLayers'),
      setNumExpLayers: fqSet('numExpLayers'),
      setClientStructures: fqSet('clientStructures'),
      setQuoteStructures: fqSet('quoteStructures'),
      setApprovedStructures: fqSet('approvedStructures'),
      setQuotePricing: fqSet('quotePricing'),
      setQuoteCobUwLimits: fqSet('quoteCobUwLimits'),
      setCobToggles: fqSet('cobToggles'),
      setCobManual: fqSet('cobManual'),
      setSelectedCobs: fqSet('selectedCobs'),
      setCobList: fqSet('cobList'),
      setOfferStatus: workflowSet('offerStatus'),
      setOfferApprover: workflowSet('offerApprover'),
      setOfferComment: workflowSet('offerComment'),
      setReturnReason: workflowSet('returnReason'),
      setDeclineReason: workflowSet('declineReason'),
      setLayerWrittenLines: workflowSet('layerWrittenLines'),
      setSignedLinePcts: workflowSet('signedLinePcts'),
      setApprovalTrail: workflowSet('approvalTrail'),
      setEligibleApprovers: workflowSet('eligibleApprovers'),
      setShowDeclineModal: modalsSet('showDeclineModal'),
      setShowOfferModal: modalsSet('showOfferModal'),
      setShowReinsurerModal: modalsSet('showReinsurerModal'),
      setShowTechAnalysisModal: modalsSet('showTechAnalysisModal'),
      setShowCobModal: modalsSet('showCobModal'),
      setMarketModalOpen: modalsSet('marketModalOpen'),
      setInsightOpen: modalsSet('insightOpen'),
      setInsightKey: modalsSet('insightKey'),
      setBenchmarkModal: modalsSet('benchmarkModal'),
      setPricingGraphModal: modalsSet('pricingGraphModal'),
      setPricingAnalysisModal: modalsSet('pricingAnalysisModal'),
      setLoading: uiSet('loading'),
      setProgLimView: uiSet('progLimView'),
      setReinsurers: refDataSet('reinsurers'),
      setPortfolioTreaties: refDataSet('portfolioTreaties'),
      setPortfolioExportRows: refDataSet('portfolioExportRows'),
      setCedantProgLimit: refDataSet('cedantProgLimit'),
      setContractAgg100: refDataSet('contractAgg100'),
      setOtherCountryAgg: refDataSet('otherCountryAgg'),
      setLastUpdatedAt: (lastUpdatedAt: string | null) => dispatch({ type: 'save/lock', lastUpdatedAt }),
      saveStart: () => dispatch({ type: 'save/start' }),
      saveSaved: (at: number) => dispatch({ type: 'save/saved', at }),
      saveFailed: (at: number, error: string) => dispatch({ type: 'save/failed', at, error }),
      engineStart: (structureIndex: number | null) => dispatch({ type: 'engine/start', structureIndex }),
      engineFinish: (structureIndex: number | null) => dispatch({ type: 'engine/finish', structureIndex }),
      engineError: (message: string) => dispatch({ type: 'engine/error', message }),
      applyEngineResults: (results: EngineLayerResult[]) => dispatch({ type: 'layers/applyEngineResults', results }),
      applyQuoteEngineResults: (byKey: Map<string, EngineLayerResult>) => dispatch({ type: 'fq/applyQuoteEngineResults', byKey }),
      openBenchmark: (scope: string, sourceLabel: string, sourceLayers: LooseRecord[]) =>
        dispatch({ type: 'modals/openBenchmark', scope, sourceLabel, sourceLayers }),
      closeBenchmark: () => dispatch({ type: 'modals/closeBenchmark' }),
      openPricingGraph: (sourceLabel: string, structure: QuoteStructureDraft) =>
        dispatch({ type: 'modals/openPricingGraph', sourceLabel, structure }),
      closePricingGraph: () => dispatch({ type: 'modals/closePricingGraph' }),
      openPricingAnalysis: (structureIndex: number) => dispatch({ type: 'modals/openPricingAnalysis', structureIndex }),
      closePricingAnalysis: () => dispatch({ type: 'modals/closePricingAnalysis' }),
      editExpLayer: (index: number, field: string, value: unknown) =>
        dispatch({ type: 'fq/editExpLayer', index, field, value }),
      applyNumExpLayers: (n: number) => dispatch({ type: 'fq/setNumExpLayers', n }),
      removeClientStructureLayer: (structureIndex: number, layerIndex: number) =>
        dispatch({ type: 'fq/removeStructureLayer', structureIndex, layerIndex }),
      removeClientStructure: (index: number) => dispatch({ type: 'fq/removeStructure', index }),
      setApprovedQuoteStructure: (index: number, checked: boolean) =>
        dispatch({ type: 'fq/setApprovedStructure', index, checked }),
      setCobToggle: (scope: string, cobId: string | number, layerIndex: number, currentFlag: boolean) =>
        dispatch({ type: 'fq/setCobToggle', scope, cobId, layerIndex, currentFlag }),
      updateUwLimit: (scope: string, cobId: string | number, value: string) =>
        dispatch({ type: 'fq/setCobUwLimit', scope, cobId, value }),
      resetForContractSwitch: () => dispatch({ type: 'contract/reset' }),
    };
  }, [dispatch]);

  const {
    layers: { layers, leadSetup, localStructureLayers, treatyMetrics, cobUwLimits, expiringEgnpi },
    fq: {
      expLayers, numExpLayers, clientStructures, quoteStructures, approvedStructures,
      quotePricing, quoteCobUwLimits, cobToggles, cobManual, selectedCobs, cobList,
    },
    workflow: {
      offerStatus, offerApprover, offerComment, returnReason, declineReason,
      layerWrittenLines, signedLinePcts, approvalTrail, eligibleApprovers,
    },
    modals,
    saveLifecycle: { saveState, lastUpdatedAt },
    ui: { loading, calcEngineRunning, calcEngineError, runningStructures, progLimView },
    refData: {
      reinsurers, portfolioTreaties, portfolioExportRows,
      cedantProgLimit, contractAgg100, otherCountryAgg,
    },
  } = state;

  const {
    setLayers, setLeadSetup, setLocalStructureLayers, setTreatyMetrics, setCobUwLimits,
    setExpiringEgnpi, setExpLayers, setNumExpLayers, setClientStructures, setQuoteStructures,
    setApprovedStructures, setQuotePricing, setQuoteCobUwLimits, setCobToggles, setCobManual,
    setSelectedCobs, setCobList, setOfferStatus, setOfferApprover, setOfferComment,
    setLayerWrittenLines, setSignedLinePcts, setApprovalTrail, setEligibleApprovers,
    setShowOfferModal, setLoading, setReinsurers, setPortfolioTreaties, setPortfolioExportRows,
    setCedantProgLimit, setContractAgg100, setOtherCountryAgg, setLastUpdatedAt,
    resetForContractSwitch,
  } = setters;

  // ── Derived pricing curve for quote mode ───────────────────────────────
  const quoteCurve = useMemo(
    () => fqBuildPricingCurve({ expLayers, structures: clientStructures, npDetail } as any),
    [expLayers, clientStructures, npDetail],
  );

  // ── Quote-structure edit dispatchers that need params from this scope ──
  const updateClientStructureLayer = useCallback((sIdx: number, lIdx: number, field: string, val: unknown) => {
    dispatch({ type: 'fq/editStructureLayer', structureIndex: sIdx, layerIndex: lIdx, field, value: val, curve: quoteCurve });
  }, [quoteCurve]);

  const perilDefaults: PerilDefaults = useMemo(
    () => ({ riskDisabled, catDisabled }),
    [riskDisabled, catDisabled],
  );
  const addQuoteStructure = useCallback(() => {
    dispatch({ type: 'fq/addStructure', idBase: Date.now(), defaults: perilDefaults });
  }, [perilDefaults]);
  const addClientStructureLayer = useCallback((sIdx: number) => {
    dispatch({ type: 'fq/addStructureLayer', structureIndex: sIdx, defaults: perilDefaults });
  }, [perilDefaults]);

  // ── Treaty-mode layer edit (reducer guards terminal offer status) ──────
  const updateLayer = useCallback((idx: number, field: string, value: unknown) => {
    dispatch({
      type: 'layers/edit',
      index: idx,
      field,
      value,
      brokeragePct: npDetail.brokeragePct,
      taxesPct: npDetail.taxesPct,
    });
  }, [npDetail.brokeragePct, npDetail.taxesPct]);

  const updateLeadSetup = useCallback((idx: number, field: string, value: unknown) => {
    dispatch({ type: 'layers/editLeadSetup', index: idx, field, value });
  }, []);

  // ── COB participation helpers (quote mode) ─────────────────────────────
  const getCobUwLimit = (scope: string, cobId: string | number): string =>
    (quoteCobUwLimits[scope] && quoteCobUwLimits[scope][cobId as string]) || '';
  const getCobFlags = useCallback((scope: string, cobId: string | number, layerRows: LooseRecord[]) => {
    const stored = (cobToggles[scope] && cobToggles[scope][cobId as string]) || [];
    const manual = (cobManual[scope] && cobManual[scope][cobId as string]) || [];
    const ul = toN((quoteCobUwLimits[scope] && quoteCobUwLimits[scope][cobId as string]) || '');
    return layerRows.map((l, i) => {
      if (manual[i]) return !!stored[i];
      return ul > toN(l.attachment);
    });
  }, [cobToggles, cobManual, quoteCobUwLimits]);

  // ── Reset local state when contract changes ──
  const prevCidRef = useRef(contractId);
  useEffect(() => {
    if (prevCidRef.current !== contractId) {
      prevCidRef.current = contractId;
      resetForContractSwitch();
    }
  }, [contractId, resetForContractSwitch]);

  // Programme snapshot is derived here; the loads live in
  // useNpPricingLoads (same effect order: COB list → quote scaffold →
  // main load → treaty metrics → portfolio).
  // Programme snapshot
  const snap = useMemo(() => ({
    cedant: npDetail.cedantName || npDetail.cedant || '–',
    treatyType: npDetail.treatyTypeName || npDetail.treatyType || '–',
    cob: selectedCobs.map((c) => c.name).filter(Boolean).join(', ')
      || (npDetail.lineOfBusinessLabels || []).join(', ')
      || npDetail.classOfBusiness
      || '–',
    xlType: npDetail.xlType || npDetail.xl_type || npDetail.typeOfXl || '–',
    renewal: npDetail.renewalDate || npDetail.renewal_date || npDetail.inceptionDate || '–',
  }), [npDetail, selectedCobs]);

  useNpPricingLoads({
    contractId, quoteMode, isQuote, npDetail, countryId,
    localStructureLayers, setters,
  });


  const uwPriceSum   = layers.reduce((s, l) => s + (parseFloat(String(l.uwPrice).replace(/%/g,'')) || 0), 0);
  const pureBurnSum  = layers.reduce((s, l) => s + (parseFloat(String(l.riskPureBurn || l.catPureBurn || '').replace(/%/g,'')) || 0), 0);
  // techRatioAvg: EP-weighted average = SUMPRODUCT(ep_i × techRatio_i) / SUM(ep_i)
  const techRatioAvg = useMemo(() => {
    let num2 = 0, denom = 0;
    layers.forEach(l => {
      const tr  = parseFloat(String(l.technicalRatio || '').replace(/%/g, '')) || 0;
      const ep  = toN(l.earnedPremium) || (toN(l.reinsurerPricing) > 0 && toN(l.limit) > 0
                    ? toN(l.limit) * toN(l.reinsurerPricing) / 100 : 0);
      if (tr > 0 && ep > 0) { num2 += ep * tr; denom += ep; }
    });
    return denom > 0 ? num2 / denom : 0;
  }, [layers]);

  // ── Auto-populate Pricing table columns ──────────────────────────────────
  // Runs whenever layers load or structureLayers sync from Structure screen.
  //
  // REINSURER = UW Price (or Total ROL) per layer.
  //   • Pure CAT XL  → skip risk-only layers
  //   • Pure Risk XL → skip cat-only layers
  //   • All others   → use each layer as-is
  //
  // LEAD = ROL from NP Structure screen (AppContext npStructureLayers, set on structure save/load)
  //
  // EXPIRING = prototype interpolation logic:
  //   Build expKnown = sorted list of [layerIndex, rolPct] from expiring layers that have a ROL.
  //   For each current layer i:
  //     a. Direct index match → use that ROL
  //     b. i < first known index  → clamp to first value
  //     c. i > last  known index  → clamp to last  value
  //     d. Otherwise              → linear interpolation between surrounding points

  // Stable content hash for the structure-layer ROL lookups consumed by
  // the effect below. Without this, the deps array ended at
  // `structureLayers.length` — which never changes when only the ROL
  // values mutate (e.g. user edits NpStructure and bounces back to
  // NpFinalPricing before the relational fetch refills
  // `localStructureLayers`). The result was stale LEAD prices on the
  // pricing screen until a full reload.
  const structLayersHash = useMemo(() => {
    const src: any[] = (localStructureLayers && localStructureLayers.length) ? localStructureLayers : structureLayers;
    if (!Array.isArray(src)) return '';
    return src.map(s => `${s?.layer ?? ''}:${s?.rol ?? ''}`).join('|');
  }, [localStructureLayers, structureLayers]);

  const autoColumnInputsRef = useRef({
    layers,
    localStructureLayers,
    structureLayers,
    brokeragePct: npDetail.brokeragePct,
    taxesPct: npDetail.taxesPct,
  });
  useEffect(() => {
    autoColumnInputsRef.current = {
      layers,
      localStructureLayers,
      structureLayers,
      brokeragePct: npDetail.brokeragePct,
      taxesPct: npDetail.taxesPct,
    };
  }, [layers, localStructureLayers, structureLayers, npDetail.brokeragePct, npDetail.taxesPct]);
  const layerCount = layers.length;

  useEffect(() => {
    const {
      layers: currentLayers,
      localStructureLayers: localLayers,
      structureLayers: contextStructureLayers,
      brokeragePct,
      taxesPct,
    } = autoColumnInputsRef.current;
    if (!layerCount || !currentLayers.length) return;

    // Shared: structure layers for ROL lookups (used by LEAD column below).
    const srcStructLayers: any[] = localLayers.length ? localLayers : contextStructureLayers;
    const structRolFor = (l: LayerPricing, i: number) => {
      const lIdx = layerIdx(l.layer) || (i + 1);
      const sl = srcStructLayers.find((s: any) => (layerIdx(s.layer) || 0) === lIdx) || srcStructLayers[i];
      return sl ? num(sl.rol) : 0;
    };

    // ── REINSURER per layer ──
    // Source the price from the component that matches the treaty type:
    // CAT XL → cat UW only, RISK XL → risk UW only, anything else → sum.
    const reinsurerByLayer = currentLayers.map(l => {
      if (mode === 'CAT'  && l.risk && !l.cat) return '';
      if (mode === 'RISK' && l.cat  && !l.risk) return '';
      const riskUw = num(l.riskUwPrice) || num(l.riskTotalPrice);
      const catUw  = num(l.catUwPrice)  || num(l.catTotalPrice);
      const uw =
        mode === 'CAT'  ? catUw  :
        mode === 'RISK' ? riskUw :
                          riskUw + catUw;
      return uw > 0 ? fmtPct(uw) : '';
    });


    // ── LEAD per layer — ROL directly from the Structure screen's ROL column.
    const leadByLayer = currentLayers.map((l, i) => {
      const rol = structRolFor(l, i);
      return rol > 0 ? fmtPct(rol) : '';
    });

    // The per-layer expiring resolution + margin/ratio recalcs live in the
    // reducer ('layers/applyAutoColumns') so a layer add/remove during the
    // async gap can't mis-align array positions.
    const applyColumns = (snapArg: { reinsurer: string[]; lead: string[] }, expKnown: Array<[number, number]> | null) => {
      dispatch({ type: 'layers/applyAutoColumns', snap: snapArg, expKnown, brokeragePct, taxesPct });
    };

    // Capture computed arrays before async gap
    const snapCols = { reinsurer: reinsurerByLayer, lead: leadByLayer };

    if (!contractId) { applyColumns(snapCols, null); return; }

    const qm = quoteMode ? { quote: true } : undefined;
    api.getNpExpiring(contractId, qm).then((exp: any) => {
      const expLayerRows = exp?.layers || [];
      // Build expKnown sorted by layer index: [[idx, rolPct], ...]
      const expKnown: Array<[number, number]> = [];
      expLayerRows.forEach((el: any, i: number) => {
        const idx = layerIdx(el.layer_number ?? el.layer) || (i + 1);
        const rol = num(el.rol ?? el.rate);
        if (rol > 0) expKnown.push([idx, rol]);
      });
      expKnown.sort((a, b) => a[0] - b[0]);
      applyColumns(snapCols, expKnown);
    }).catch((e: unknown) => {
      console.warn('[NpFinalPricing] getNpExpiring failed', e);
      applyColumns(snapCols, null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerCount, uwPriceSum, pureBurnSum, structLayersHash, mode, contractId, quoteMode]);

  // ── Historical Margin: losses-into-structure with sequential per-loss reinstatements ──────────
  // Dep key: structure terms + pricing (so effect reruns when UW price is entered).
  // Runs immediately on load using leadPricing as fallback if reinsurer not yet set.
  const histMarginDepKey = layers.map(l =>
    `${l.limit}|${l.deductible}|${l.noReinst}|${l.reinstPct}|${l.reinsurerPricing}|${l.leadPricing}`
  ).join(',');
  useEffect(() => {
    if (!contractId || !layers.length) return;
    const cancelled = false;
    const qm = quoteMode ? { quote: true } : undefined;
    Promise.all([
      api.getLargeLosses(contractId, qm).catch(() => ({ losses: [] })),
      api.getCatLosses(contractId, qm).catch(() => ({ losses: [] })),
    ]).then(([rawLarge, rawCat]) => {
      if (cancelled) return;
      // API returns { report, losses: [...] } — unwrap
      const extractRows = (r: any) => Array.isArray(r) ? r : (r?.losses ?? []);
      const norm = (r: any) => ({
        uwYear:   String(r.uw_year ?? r.uwYear ?? ''),
        incurred: (parseFloat(r.incurred ?? 0) || 0) * (parseFloat(r.inflation_factor ?? 1) || 1),
        selected: (r.is_selected ?? r.isSelected) !== false,
      });
      const largeLosses = extractRows(rawLarge).map(norm).filter((r: any) => r.selected && r.uwYear && r.incurred > 0);
      const catLosses   = extractRows(rawCat).map(norm).filter((r: any) => r.selected && r.uwYear && r.incurred > 0);

      const buildByYear = (losses: Array<{ uwYear: string; incurred: number }>) => {
        const byYear = new Map<string, number[]>();
        for (const r of losses) {
          if (!byYear.has(r.uwYear)) byYear.set(r.uwYear, []);
          (byYear.get(r.uwYear) as number[]).push(r.incurred);
        }
        return byYear;
      };

      const largeByYear = buildByYear(largeLosses);
      const catByYear   = buildByYear(catLosses);
      const bothByYear  = buildByYear([...largeLosses, ...catLosses]);

      if (!largeByYear.size && !catByYear.size) return;

      dispatch({
        type: 'layers/applyHistoricalMargins',
        largeByYear, catByYear, bothByYear,
        brokeragePct: npDetail.brokeragePct,
        taxesPct: npDetail.taxesPct,
      });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, quoteMode, histMarginDepKey, layers.length, npDetail.brokeragePct, npDetail.taxesPct]);

  // ── Tech Ratio: recompute whenever historicalMargin changes ──────────
  // historicalMargin is set asynchronously by the effect above, so we need
  // a separate effect to propagate it into technicalRatio.
  const histMarginValKey = layers.map(l => l.historicalMargin || '').join(',');
  useEffect(() => {
    if (!layers.length) return;
    dispatch({
      type: 'layers/recomputeTechRatios',
      brokeragePct: npDetail.brokeragePct,
      taxesPct: npDetail.taxesPct,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histMarginValKey, layers.length, npDetail.brokeragePct, npDetail.taxesPct]);

  // Defensive: a non-array pricing slice (e.g. a stale/partial wire payload)
  // must never reach an unconditional `.map` in NpFinalPricing and white-screen
  // the render. asArr returns the SAME reference when v is already an array, so
  // the happy path allocates nothing and the golden master stays byte-identical.
  const asArr = <T,>(v: T[]): T[] => (Array.isArray(v) ? v : []);

  return {
    // raw state
    layers: asArr(layers), leadSetup: asArr(leadSetup), localStructureLayers: asArr(localStructureLayers), treatyMetrics, cobUwLimits: asArr(cobUwLimits), expiringEgnpi,
    expLayers: asArr(expLayers), numExpLayers, clientStructures: asArr(clientStructures), quoteStructures: asArr(quoteStructures), approvedStructures: asArr(approvedStructures),
    quotePricing, quoteCobUwLimits, cobToggles, cobManual, selectedCobs: asArr(selectedCobs), cobList: asArr(cobList),
    offerStatus, offerApprover, offerComment, returnReason, declineReason,
    layerWrittenLines, signedLinePcts, approvalTrail: asArr(approvalTrail), eligibleApprovers: asArr(eligibleApprovers),
    showDeclineModal: modals.showDeclineModal,
    showOfferModal: modals.showOfferModal,
    showReinsurerModal: modals.showReinsurerModal,
    showTechAnalysisModal: modals.showTechAnalysisModal,
    showCobModal: modals.showCobModal,
    marketModalOpen: modals.marketModalOpen,
    insightOpen: modals.insightOpen,
    insightKey: modals.insightKey,
    benchmarkModal: modals.benchmarkModal,
    pricingGraphModal: modals.pricingGraphModal,
    pricingAnalysisModal: modals.pricingAnalysisModal,
    saveState, lastUpdatedAt,
    loading, calcEngineRunning, calcEngineError, runningStructures, progLimView,
    reinsurers: asArr(reinsurers), portfolioTreaties: asArr(portfolioTreaties), portfolioExportRows: asArr(portfolioExportRows),
    cedantProgLimit, contractAgg100, otherCountryAgg,
    // derived
    quoteCurve, snap, techRatioAvg,
    // dispatch surface
    ...setters,
    updateLayer, updateLeadSetup, updateClientStructureLayer,
    addQuoteStructure, addClientStructureLayer,
    getCobUwLimit, getCobFlags,
  };
}

export type NpPricingStateApi = ReturnType<typeof useNpPricingState>;
export default useNpPricingState;
