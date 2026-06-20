// hooks/useNpStructureState.ts — all state, effects and persistence for the
// NP Structure screen (Phase 4.2 decomposition of NpStructure.jsx).
//
// The orchestrator (NpStructure.jsx) renders; this hook owns:
//   • the typed reducer store (state/structureReducer.ts)
//   • the load pipeline (structure + expiring, hydration order preserved
//     exactly from the pre-refactor hand-rolled effect)
//   • the npTreatyDetail re-sync / COB-row sync / slice-mirror effects
//   • save() with optimistic-lock + stale-write handling
//
// Every effect body and dependency array was carried over verbatim from
// the pre-refactor screen — goldenMaster.test.jsx pins the observable
// behaviour. The npStructureLayers slice write points (load, load-failure,
// edit mirror) are preserved exactly: NpFinalPricing and NpStopLossPricing
// read that slice.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import { api } from '../../../../api';
import { useContractId } from '../../../../hooks/useContractId';
import { useGlobalToast } from '../../../../hooks/useToast';
import { useAppState } from '../../../../context/AppContext';
import { ACTIVE_QUOTE_ID } from '../../../../constants/storageKeys';
import { handleStaleWrite } from '../../../../utils/handleStaleWrite';
import { REINSTATEMENT_OPTIONS } from '../../reinstatementOptions';
import { logger } from '../../../../utils/logger';

/* handleStaleWrite is a plain-JS util; its inferred options type collapses
   to `{ entityType?: string }`, so give the call site an honest signature. */
const handleStaleWriteTyped = handleStaleWrite as (
  error: unknown,
  opts: {
    entityType?: string;
    onRefresh?: (payload?: unknown) => unknown;
    onOverwrite?: (payload?: unknown) => unknown;
  },
) => Promise<{ handled: boolean; action?: string; result?: unknown }>;
import { getNpTreatyTypeMode, isNpStopLossTreaty, isNpAggregateXlTreaty } from '../../../../utils/npTreatyType';
import { toNum, rateToFloat, emptyLayer, emptyCoveredProp, parseClipboard } from '../NpStructureHelpers';
import {
  structureReducer,
  initialStructureState,
  applyTreatyModeCovers as applyTreatyModeCoversPure,
  recomputeDeductibles as recomputeDeductiblesPure,
  recomputeFinancials as recomputeFinancialsPure,
  expiringRecalc as expiringRecalcPure,
} from '../state/structureReducer';
import type { CobOption, ExpiringLayerRow, ExpiringTermKey, LayerRow } from '../state/structureReducer';
import { hydrateExpiringResponse, hydrateStructureResponse, mergeWithCurrent } from '../state/structureHydration';

/** Snapshot returned by a QuoteStructureSection collect ref. */
interface QuoteStructureSnapshot {
  layersCount?: unknown;
  layers?: LayerRow[];
  cobRows?: Array<Record<string, any>>;
}
type StructSectionRef = { current?: (() => QuoteStructureSnapshot) | null } | undefined;

export function useNpStructureState() {
  const contractId = useContractId();
  const showToast = useGlobalToast();
  const { state: appState, setSlice, replaceSlice, structRefsMap } = useAppState();
  const [state, dispatch] = useReducer(structureReducer, initialStructureState);
  const {
    layers, cobRows, coveredProps, cobOptions, savedQuoteStructures, loading,
    expiringLayerCount, expiringLayers, expiringTerms, isRenewal,
    expiringAutoPopulated, expiringCoveredProps, lastUpdatedAt, showExpCurveModal,
  } = state;
  const loaded = useRef(false);
  const dirty = useRef(false);

  // Live mirrors of the Stop Loss / Aggregate XL slices. The load
  // effect's deps deliberately don't include these (we don't want
  // re-loads on every keystroke), so its closure can't see fresh
  // slice values — refs let the merge step read the latest in-flight
  // edits at the moment the server response arrives. Mirrors the
  // sliceRef pattern in NpStopLossPricing.onLoaded.
  const stopLossSliceRef = useRef(appState.npStopLossInputs);
  stopLossSliceRef.current = appState.npStopLossInputs;
  const aggregateXlSliceRef = useRef(appState.npAggregateXlInputs);
  aggregateXlSliceRef.current = appState.npAggregateXlInputs;
  const stopLossExpiringSliceRef = useRef(appState.npStopLossExpiring);
  stopLossExpiringSliceRef.current = appState.npStopLossExpiring;

  /* Quote mode detection */
  const quoteMode = !!(appState.quoteMode) || (() => {
    try { return !!localStorage.getItem(ACTIVE_QUOTE_ID); } catch { return false; }
  })();

  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const mode = getNpTreatyTypeMode(appState);
  const currency: string = npDetail.currencyCode || npDetail.currency || 'SAR';

  // Keep expiringLayerCount in sync with Treaty Detail's expiringNumberOfLayers
  // Only override when no relational rows have been saved yet (expiringLayers is empty)
  useEffect(() => {
    const n = parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '0', 10) || 0;
    if (n > 0 && expiringLayers.length === 0) {
      dispatch({ type: 'expiring/countSynced', count: n });
    }
  }, [expiringLayers.length, npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers]);

  // Mirror local layers → global npStructureLayers slice. Runs after
  // commit (effect phase) so callers like updateLayer don't have to
  // touch the cross-tree slice from inside a state transition, which
  // triggered React's "setState during render" warning.
  useEffect(() => {
    replaceSlice('npStructureLayers', layers);
  }, [layers, replaceSlice]);

  /* Structures to Quote: stored in npTreatyDetail so it persists across screens */
  const structuresCount = Math.max(1, parseInt(npDetail.quoteStructuresCount || '1', 10) || 1);
  const updateStructuresCount = useCallback((val: string) => {
    setSlice('npTreatyDetail', { quoteStructuresCount: val });
  }, [setSlice]);

  const isNetXl = useMemo(() => {
    const raw = String(npDetail.xlType || npDetail.xl_type || npDetail.typeOfXl || '').trim().toLowerCase().replace(/_/g, ' ');
    return raw.includes('net') && raw.includes('xl');
  }, [npDetail]);

  const getNumLayers = useCallback(() => {
    const n = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '4', 10);
    return Number.isFinite(n) && n > 0 ? n : 4;
  }, [npDetail]);

  const getBaseDeductible = useCallback(() => {
    return String(toNum(npDetail.deductible || npDetail.maxRetention || npDetail.attachment || 0));
  }, [npDetail]);

  /* ── Recalc pipeline wrappers ──
     The math lives in state/structureReducer.ts (pure); these wrappers keep
     the pre-refactor useCallback identity chain so the load effect re-fires
     on exactly the same npTreatyDetail / mode changes as before. */
  const recomputeDeductibles = useCallback(
    (allLayers: LayerRow[]) => recomputeDeductiblesPure(allLayers, getBaseDeductible()),
    [getBaseDeductible],
  );
  const recomputeFinancials = useCallback((l: LayerRow) => recomputeFinancialsPure(l), []);
  const fullRecalc = useCallback((allLayers: LayerRow[]) => {
    const withDed = recomputeDeductibles(allLayers);
    return withDed.map(l => recomputeFinancials(l));
  }, [recomputeDeductibles, recomputeFinancials]);
  const recalcFinancialsOnly = useCallback(
    (allLayers: LayerRow[]) => allLayers.map(l => recomputeFinancials(l)),
    [recomputeFinancials],
  );
  const expiringRecalc = useCallback(
    (allLayers: ExpiringLayerRow[], skipDedCascade = false) => expiringRecalcPure(allLayers, skipDedCascade),
    [],
  );
  const applyTreatyModeCovers = useCallback(
    (allLayers: LayerRow[]) => applyTreatyModeCoversPure(allLayers, mode),
    [mode],
  );

  /* ── Load COB options ── */
  useEffect(() => {
    let cancelled = false;
    async function loadCobs() {
      try {
        if (contractId) {
          const data = await api.getContractCobs(contractId, quoteMode ? { quote: true } : undefined);
          if (cancelled) return;
          if (Array.isArray(data) && data.length) {
            dispatch({
              type: 'cob/optionsLoaded',
              options: data
                .map(c => ({
                  id: String(c.id ?? c.class_of_business_id ?? ''),
                  name: String(c.name ?? c.class_of_business ?? ''),
                  code: String(c.code ?? ''),
                }))
                .filter(x => x.id && x.name),
            });
            return;
          }
        }
        // No contractId or getContractCobs returned empty
        // Use classIds from appState to filter the full list to only selected COBs
        const all = await api.listClassOfBusiness();
        if (!cancelled) {
          const selectedIds = new Set<string>((npDetail.classIds || []).map(String));
          const filtered: CobOption[] = Array.isArray(all)
            ? (selectedIds.size > 0 ? all.filter(c => selectedIds.has(String(c.id))) : all)
            : [];
          dispatch({ type: 'cob/optionsLoaded', options: filtered });
        }
      } catch {
        if (cancelled) return;
        try {
          const all = await api.listClassOfBusiness();
          if (!cancelled) {
            const selectedIds = new Set<string>((npDetail.classIds || []).map(String));
            const filtered: CobOption[] = Array.isArray(all)
              ? (selectedIds.size > 0 ? all.filter(c => selectedIds.has(String(c.id))) : all)
              : [];
            dispatch({ type: 'cob/optionsLoaded', options: filtered });
          }
        } catch { /* silent */ }
      }
    }
    loadCobs();
    return () => { cancelled = true; };
  }, [contractId, npDetail.classIds, quoteMode]);

  /* ── Load structure data from server ──
     Hydration mapping lives in state/structureHydration.ts; the ordering of
     slice writes inside each .then() is unchanged from the pre-refactor
     effect (layers → npStructureLayers mirror → cobRows/coveredProps →
     stop-loss/aggregate-XL slice merges, all in one commit). ── */
  useEffect(() => {
    if (!contractId) return;
    dispatch({ type: 'load/started' });
    // Resolve quote mode: appState is authoritative, fall back to localStorage
    // in case RESET_FLOW hasn't propagated before this effect fires
    const isQuoteLoad = quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    api.getNonPropTreaty(contractId, isQuoteLoad ? { quote: true } : undefined)
      .then(data => {
        const hydrated = hydrateStructureResponse(data, {
          quoteMode,
          mode,
          numLayersFallback: getNumLayers(),
        });
        dispatch({
          type: 'load/structureLoaded',
          layers: hydrated.layers,
          cobRows: hydrated.cobRows,
          savedQuoteStructures: hydrated.savedQuoteStructures,
          coveredProps: hydrated.coveredProps,
          lastUpdatedAt: hydrated.lastUpdatedAt,
        });
        replaceSlice('npStructureLayers', hydrated.layers);
        // Merge the JSONB stop-loss / aggregate-XL backups under in-flight
        // slice edits — non-empty existing fields win, server fills the rest.
        if (hydrated.stopLossSlice) {
          setSlice('npStopLossInputs', mergeWithCurrent(stopLossSliceRef.current, hydrated.stopLossSlice));
        }
        if (hydrated.aggregateXlSlice) {
          setSlice('npAggregateXlInputs', mergeWithCurrent(aggregateXlSliceRef.current, hydrated.aggregateXlSlice));
        }
        if (hydrated.stopLossExpiringSlice) {
          setSlice('npStopLossExpiring', mergeWithCurrent(stopLossExpiringSliceRef.current, hydrated.stopLossExpiringSlice));
        }
      })
      .catch(() => {
        const count = getNumLayers();
        let ls = Array.from({ length: count }, (_, i) => emptyLayer(i) as LayerRow);
        ls = applyTreatyModeCovers(ls);
        ls = fullRecalc(ls);
        dispatch({ type: 'load/structureFailed', layers: ls, coveredProps: [emptyCoveredProp()] });
        replaceSlice('npStructureLayers', ls);
      })
      .finally(() => { dispatch({ type: 'load/finished' }); loaded.current = true; });
    // Load expiring structure in parallel
    api.getNpExpiring(contractId, isQuoteLoad ? { quote: true } : undefined).then(exp => {
      const fallbackCount = parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '0', 10) || 0;
      const hydrated = hydrateExpiringResponse(exp, fallbackCount);
      if (!hydrated) return;
      dispatch({
        type: 'load/expiringLoaded',
        isRenewal: hydrated.isRenewal,
        autoPopulated: hydrated.autoPopulated,
        layerCount: hydrated.layerCount,
        layers: hydrated.layers,
        terms: hydrated.terms,
        coveredProps: hydrated.coveredProps,
      });
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dependency contract carried over verbatim from the pre-refactor screen
  }, [contractId, getNumLayers, applyTreatyModeCovers, fullRecalc, recalcFinancialsOnly, quoteMode, setSlice, replaceSlice, expiringRecalc, npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers]);

  /* ── Re-sync layers when treaty detail deductible or numberOfLayers changes ──
     When the user edits these fields on Treaty Detail and navigates back to Structure,
     the layers should reflect the updated base deductible and layer count without
     requiring a full page reload or server re-fetch.
     - If deductible changes: re-cascade deductibles from layer 1 (full recalc pipeline).
     - If numberOfLayers changes: add/trim layers to match, then recalc.
     Guards:
       - Only runs when layers are already loaded (length > 0).
       - Uses refs to track the previous values so we only act on actual changes.
  ── */
  const prevDedRef = useRef<string | null>(null);
  const prevNumLayersRef = useRef<number | null>(null);
  useEffect(() => {
    if (!layers.length) return;
    const curDed = String(toNum(npDetail.deductible || npDetail.maxRetention || 0));
    const curNum = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '0', 10) || 0;

    const dedChanged       = prevDedRef.current !== null && prevDedRef.current !== curDed;
    const numLayersChanged = prevNumLayersRef.current !== null && curNum > 0 && prevNumLayersRef.current !== curNum;

    prevDedRef.current       = curDed;
    prevNumLayersRef.current = curNum;

    if (!dedChanged && !numLayersChanged) return;

    dispatch({
      type: 'layers/resyncedFromDetail',
      numLayersChanged,
      count: curNum,
      baseDeductible: getBaseDeductible(),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dependency contract carried over verbatim from the pre-refactor screen
  }, [fullRecalc, layers.length, npDetail.deductible, npDetail.maxRetention, npDetail.numberOfLayers, npDetail.number_of_layers]);

  /* ── Ensure COB rows match treaty detail COBs ──
     Two jobs (the transition lives in the reducer's cob/rowsEnsured case):
     1. If cobRows is empty (first visit, no saved data), initialise from cobOptions.
     2. Backfill any cobRow whose name is missing/empty once cobOptions loads.
        This fixes the race where relational load fires before cobOptions resolves.
  ── */
  useEffect(() => {
    if (!cobOptions.length || !layers.length) return;
    dispatch({ type: 'cob/rowsEnsured' });
  }, [cobOptions, layers.length]);

  /* ── Update a single layer field ── */
  const updateLayer = useCallback((idx: number, field: string, value: string | boolean) => {
    dispatch({ type: 'layer/fieldEdited', idx, field, value, baseDeductible: getBaseDeductible() });
    dirty.current = true;
  }, [getBaseDeductible]);

  const addLayer = useCallback(() => {
    dispatch({ type: 'layer/added', baseDeductible: getBaseDeductible() });
    dirty.current = true;
  }, [getBaseDeductible]);

  const deleteLastLayer = useCallback(() => {
    dispatch({ type: 'layer/lastDeleted', baseDeductible: getBaseDeductible() });
    dirty.current = true;
  }, [getBaseDeductible]);

  /* ── Excel paste handler for layer table ── */
  const handleLayerPaste = useCallback((e: ReactClipboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tr = target.closest('tr[data-layer-row]');
    if (!tr) return;
    const startRow = Number(tr.getAttribute('data-layer-row'));
    // Determine the field from data-paste-field attribute
    const field = target.getAttribute('data-paste-field');
    if (!Number.isFinite(startRow) || !field) return;
    const clip = e.clipboardData?.getData('text') ?? '';
    const matrix = parseClipboard(clip);
    if (matrix.length <= 1 && (!matrix[0] || matrix[0].length <= 1)) return; // single cell = normal paste
    e.preventDefault();
    dispatch({ type: 'layer/pasted', startRow, field, matrix, baseDeductible: getBaseDeductible() });
    dirty.current = true;
  }, [getBaseDeductible]);

  /* ── Excel paste handler for expiring layer table ── */
  const handleExpiringPaste = useCallback((e: ReactClipboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tr = target.closest('tr[data-exp-row]');
    if (!tr) return;
    const startRow = Number(tr.getAttribute('data-exp-row'));
    const field = target.getAttribute('data-paste-field');
    if (!Number.isFinite(startRow) || !field) return;
    const clip = e.clipboardData?.getData('text') ?? '';
    const matrix = parseClipboard(clip);
    if (matrix.length <= 1 && (!matrix[0] || matrix[0].length <= 1)) return;
    e.preventDefault();
    dispatch({ type: 'expiring/pasted', startRow, field, matrix });
    dirty.current = true;
  }, []);

  /* ── COB row updates ── */
  const updateCobRow = useCallback((idx: number, field: string, value: string) => {
    dispatch({ type: 'cob/fieldEdited', idx, field, value });
    dirty.current = true;
  }, []);

  const toggleCobLayer = useCallback((cobIdx: number, layerIdx: number) => {
    dispatch({ type: 'cob/layerToggled', cobIdx, layerIdx });
    dirty.current = true;
  }, []);

  /* ── Covered props with auto-calc ── */
  const updateCoveredProp = useCallback((idx: number, field: string, value: string) => {
    dispatch({ type: 'coveredProp/edited', idx, field, value });
    dirty.current = true;
  }, []);

  const coveredPropsCalc = useMemo(() => coveredProps.map(r => {
    const qs = toNum(r.qsLimit);
    const retPct01 = rateToFloat(r.retentionPct) / 100;
    const retAmt = (qs > 0 && retPct01 > 0) ? Math.round(qs * retPct01) : 0;
    const lines = toNum(r.surplusLines);
    const totalCap = qs > 0 ? Math.round(qs * (1 + Math.max(0, lines))) : 0;
    return { ...r, retentionAmount: retAmt, totalCapacity: totalCap };
  }), [coveredProps]);

  const expiringCoveredPropsCalc = useMemo(() => expiringCoveredProps.map(r => {
    const qs = toNum(r.qsLimit);
    const retPct01 = rateToFloat(r.retentionPct) / 100;
    const retAmt = (qs > 0 && retPct01 > 0) ? Math.round(qs * retPct01) : 0;
    const lines = toNum(r.surplusLines);
    const totalCap = qs > 0 ? Math.round(qs * (1 + Math.max(0, lines))) : 0;
    return { ...r, retentionAmount: retAmt, totalCapacity: totalCap };
  }), [expiringCoveredProps]);

  // NOTE: expiring covered-prop edits deliberately do NOT flip the dirty
  // flag — matching the pre-refactor screen.
  const updateExpiringCoveredProp = useCallback((idx: number, field: string, value: string) => {
    dispatch({ type: 'expiring/coveredPropEdited', idx, field, value });
  }, []);

  const addExpiringCoveredProp = useCallback(() => {
    dispatch({ type: 'expiring/coveredPropAdded' });
  }, []);

  const removeExpiringCoveredProp = useCallback(() => {
    dispatch({ type: 'expiring/coveredPropRemoved' });
  }, []);

  /* ── Expiring layer / terms edits ── */
  const updateExpiringLayer = useCallback((idx: number, field: string, value: string | boolean) => {
    dispatch({ type: 'expiring/layerEdited', idx, field, value });
    dirty.current = true;
  }, []);

  // NOTE: term edits do not flip the dirty flag — matching the pre-refactor screen.
  const updateExpiringTerm = useCallback((key: ExpiringTermKey, value: string) => {
    dispatch({ type: 'expiring/termEdited', key, value });
  }, []);

  const enableExpiringOverride = useCallback(() => {
    dispatch({ type: 'expiring/overrideEnabled' });
  }, []);

  const setShowExpCurveModal = useCallback((open: boolean) => {
    dispatch({ type: 'modal/expCurveSet', open });
  }, []);

  const markDirty = useCallback(() => { dirty.current = true; }, []);

  /* ── Save ──
     Relational writes:
       • contract_np_layers          — every layer with all fields + peril_scope
       • contract_np_layer_class_of_business — junction: (layer_id, cob_id) per layer
       • contract_underwriting_limit — UW limit per COB (drives loss-to-layer assignment)
     JSONB write (np_structure key):
       • cobRows backup + coveredProps + quote structures
     The layer↔COB participation is derived: UW limit > attachment → COB triggers layer.
     Manual checkbox overrides are preserved in the JSONB cobRows.manual arrays.
  ── */
  const save = useCallback(async (options: { ifUnmodifiedSince?: string } = {}): Promise<boolean> => {
    if (!contractId) return true;
    if (!loaded.current) return true; // don't overwrite DB before data has loaded
    // Resolve quote mode reliably — appState + localStorage fallback
    const isQuoteSave = quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    const lockOverride = options?.ifUnmodifiedSince;
    let activeLock = lockOverride || lastUpdatedAt;
    const requestOptions = () => (
      isQuoteSave
        ? { quote: true, ...(activeLock ? { ifUnmodifiedSince: activeLock } : {}) }
        : (activeLock ? { ifUnmodifiedSince: activeLock } : undefined)
    );
    const noteSaved = (response: { updated_at?: string | null } | null | undefined) => {
      if (!response?.updated_at) return;
      activeLock = response.updated_at;
      dispatch({ type: 'save/recorded', updatedAt: response.updated_at });
    };
    const pn = (v: unknown) => { const s = String(v ?? '').replace(/,/g, ''); const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

    // Backup the Stop Loss / Aggregate XL slices into terms.np_structure
    // JSONB. These sub-component slices have no relational save path
    // here (Stop Loss is canonically saved by NpStopLossPricing's own
    // endpoint; Aggregate XL has none), so without this backup a
    // refresh on the Structure tab loses the user's edits. Store the
    // literal slice values — the consuming sub-components own the
    // shape, this screen just round-trips it.
    const stopLossInputs = appState.npStopLossInputs;
    const aggregateXlInputs = appState.npAggregateXlInputs;
    const stopLossExpiring = appState.npStopLossExpiring;
    const hasKeys = (o: unknown) => !!o && typeof o === 'object' && Object.keys(o).length > 0;
    const npStructureSliceBackup = {
      ...(hasKeys(stopLossInputs)     ? { stop_loss:          stopLossInputs }     : {}),
      ...(hasKeys(aggregateXlInputs)  ? { aggregate_xl:       aggregateXlInputs }  : {}),
      ...(hasKeys(stopLossExpiring)   ? { stop_loss_expiring: stopLossExpiring }   : {}),
    };

    let payload;
    if (quoteMode) {
      /* ── Quote mode: collect data from each QuoteStructureSection via context refs ── */
      const structures: QuoteStructureSnapshot[] = [];
      for (let i = 0; i < structuresCount; i++) {
        const ref = structRefsMap.current?.[i] as StructSectionRef;
        if (ref?.current) structures.push(ref.current());
      }
      // Quote mode — quote_np_layers has the same full column set as contract_np_layers.
      // Structure 1 layers go into the relational table; all structures also stored in JSONB.
      // COB participation per layer lives in JSONB (no junction table for quotes).
      // UW limits go into quote_underwriting_limit (shared across all structures in a quote).

      // Collect UW limits from structure 1 (the primary structure)
      const struct0CobRows = structures[0]?.cobRows || [];
      const quoteCobUwLimits = struct0CobRows
        .filter(r => r.cobId)
        .map(r => ({ cob_id: String(r.cobId), limit_amount: pn(r.underwritingLimit) }));

      // Build relational layer rows from structure 1
      const struct0Layers = structures[0]?.layers || [];
      const struct0LayerCobIds = struct0Layers.map((_, li) =>
        struct0CobRows
          .filter(r => !!(r.layers && r.layers[li]))
          .map(r => String(r.cobId))
          .filter(Boolean)
      );

      payload = {
        layers: struct0Layers.map((l, i) => ({
          layer_number: i + 1,
          attachment: pn(l.deductible),
          layer_limit: pn(l.limit),
          aggregate_limit: pn(l.annualAggLimit ?? l.deductible),
          egnpi: pn(l.egnpi),
          earned_premium: null,
          rate: null,
          rol: null,
          num_reinstatements: l.reinstatements || null,
          reinstatement_pct: pn(l.reinstatementPct),
          annual_agg_deductible: pn(l.aadAmount),
          peril_scope: l.riskCover && l.catCover ? 'BOTH' : l.catCover ? 'CAT' : 'RISK',
          mdp: null,
          mdp_pct: null,
        })),
        cob_underwriting_limits: quoteCobUwLimits,
        terms: {
          np_structure: {
            structures: structures.map((st, i) => ({
              structureNo: i + 1,
              layersCount: String(st.layersCount ?? ''),
              layers: (st.layers || []).map(l => ({
                layer: l.layer, limit: l.limit, deductible: l.deductible,
                annualAggLimit: l.annualAggLimit ?? '',
                aad: !!l.aad, aadAmount: l.aadAmount,
                reinstatements: l.reinstatements, reinstatementPct: l.reinstatementPct,
                egnpi: l.egnpi,
                riskCover: l.riskCover !== undefined ? !!l.riskCover : true,
                catCover:  l.catCover  !== undefined ? !!l.catCover  : true,
              })),
              cobRows: (st.cobRows || []).map(r => ({
                cobId: r.cobId, name: r.name,
                underwritingLimit: r.underwritingLimit,
                layers: r.layers,
                manual: r.manual || [],
              })),
            })),
            layers: struct0Layers.map((l, i) => ({
              ...l, classOfBusinessIds: struct0LayerCobIds[i] || [],
            })),
            cobRows: struct0CobRows,
            coveredProps: coveredProps.filter(r => r.cobId || r.qsLimit).map(r => ({
              cobId: r.cobId, qsLimit: r.qsLimit, retentionPct: r.retentionPct, surplusLines: r.surplusLines,
            })),
            ...npStructureSliceBackup,
          },
        },
      };
    } else {
      /* ── Standard mode ──
         Derive classOfBusinessIds for each layer from cobRows state.
         A COB participates in a layer if cobRows[cob].layers[i] === true.
         This is the source of truth for the junction table.
      ── */
      const layerCobIds = layers.map((_, li) =>
        cobRows
          .filter(r => !!(r.layers && r.layers[li]))
          .map(r => String(r.cobId))
          .filter(Boolean)
      );

      payload = {
        // Relational layer rows — full data per layer
        layers: layers.map((l, i) => ({
          layer_number: i + 1,
          attachment: pn(l.deductible),
          layer_limit: pn(l.limit),
          aggregate_limit: pn(l.annualAggLimit),
          egnpi: pn(l.egnpi),
          earned_premium: pn(l.earnedPremium),
          rate: pn(l.rate),
          rol: pn(l.rol),
          num_reinstatements: pn(l.reinstatements),
          reinstatement_pct: pn(l.reinstatementPct),
          annual_agg_deductible: pn(l.aadAmount),
          // peril_scope: RISK, CAT, or BOTH — determines which loss types can trigger this layer
          peril_scope: l.riskCover && l.catCover ? 'BOTH' : l.catCover ? 'CAT' : 'RISK',
          mdp: pn(l.mdp),
          mdp_pct: pn(l.mdpPct),
          // COB participation for this layer (for junction table)
          class_of_business_ids: layerCobIds[i] || [],
        })),

        // UW limits per COB — used by loss screens to determine if a loss triggers a layer
        cob_underwriting_limits: cobRows
          .filter(r => r.cobId)
          .map(r => ({
            cob_id: String(r.cobId),
            limit_amount: pn(r.underwritingLimit),
          })),

        // JSONB backup for cobRows (preserves manual overrides + names for re-hydration)
        terms: {
          np_structure: {
            layers: layers.map(l => ({
              layer: l.layer, limit: l.limit, deductible: l.deductible,
              annualAggLimit: l.annualAggLimit, egnpi: l.egnpi, rate: l.rate,
              earnedPremium: l.earnedPremium, mdp: l.mdp, mdpPct: l.mdpPct,
              reinstatements: l.reinstatements, reinstatementPct: l.reinstatementPct,
              aad: !!l.aad, aadAmount: l.aadAmount,
              riskCover: !!l.riskCover, catCover: !!l.catCover, rol: l.rol,
            })),
            cobRows: cobRows.map(r => ({
              cobId: r.cobId, name: r.name, code: r.code || '',
              underwritingLimit: r.underwritingLimit,
              layers: r.layers,
              manual: r.manual,
            })),
            coveredProps: coveredProps.filter(r => r.cobId || r.qsLimit).map(r => ({
              cobId: r.cobId, qsLimit: r.qsLimit, retentionPct: r.retentionPct, surplusLines: r.surplusLines,
            })),
            ...npStructureSliceBackup,
          },
        },
      };
    }
    try {
      noteSaved(await api.saveNonPropTreaty(contractId, payload, requestOptions()));

      // Surface a non-blocking warning if any layer was saved with no
      // COB participation but a non-zero attachment. The pricing engine
      // reads `class_of_business_ids` to decide which losses trigger a
      // layer; an empty list means the layer will silently produce a 0
      // expected loss. The save still succeeds (an empty list is valid
      // server-side) but the underwriter should know.
      const layersWithNoCob = (payload.layers || []).filter((rl: { class_of_business_ids?: string[]; attachment: number | null; layer_number: number }) => {
        const ids = Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [];
        const hasAttach = (Number(rl.attachment) || 0) > 0;
        return ids.length === 0 && hasAttach;
      });
      if (layersWithNoCob.length > 0) {
        const numbers = layersWithNoCob.map((l: { layer_number: number }) => `L${l.layer_number}`).join(', ');
        showToast(`Saved. Note: ${layersWithNoCob.length} layer${layersWithNoCob.length === 1 ? '' : 's'} (${numbers}) ${layersWithNoCob.length === 1 ? 'has' : 'have'} no class of business — they won't be triggered by any loss in pricing.`);
      }

      // Save expiring structure to relational tables
      const expPayload = {
        layers: expiringLayers.map((l, i) => ({
          layer_number: i + 1,
          attachment:             pn(l.deductible),
          layer_limit:            pn(l.limit),
          aggregate_limit:        pn(l.annualAggLimit),
          egnpi:                  pn(l.egnpi),
          earned_premium:         pn(l.earnedPremium),
          rate:                   pn(l.rate),    // pn strips % → stores 1.5 not "1.5%"
          rol:                    pn(l.rol),
          num_reinstatements:     l.reinstatements ? parseInt(l.reinstatements) : null,
          reinstatement_pct:      pn(l.reinstatementPct),
          annual_agg_deductible:  pn(l.aadAmount),
          peril_scope: l.riskCover && l.catCover ? 'BOTH' : l.catCover ? 'CAT' : 'RISK',
          mdp:                    pn(l.mdp),
          mdp_pct:                pn(l.mdpPct),
        })),
        terms: {
          // Preserve all server fields so ON CONFLICT DO UPDATE doesn't null out auto-populated values
          egnpi:                 expiringTerms.egnpi                 ?? null,
          deductible:            expiringTerms.deductible            ?? null,
          risk_limit:            expiringTerms.risk_limit            ?? null,
          cat_limit:             expiringTerms.cat_limit             ?? null,
          brokerage_pct:         expiringTerms.brokerage_pct         ?? null,
          no_claims_bonus_pct:   expiringTerms.no_claims_bonus_pct   ?? null,
          profit_commission_pct: expiringTerms.profit_commission_pct ?? null,
          notes:                 expiringTerms.notes                 ?? null,
        },
        // coveredProps lives at TOP LEVEL — the server handler reads
        // `req.body.coveredProps`, and GET /np/expiring returns it at
        // the top level too. An earlier revision nested it inside
        // `terms`, which caused every save to persist `covered_props='[]'`.
        coveredProps: expiringCoveredProps.filter(r => r.cobId || r.qsLimit).map(r => ({
          cobId: r.cobId, qsLimit: r.qsLimit, retentionPct: r.retentionPct, surplusLines: r.surplusLines,
        })),
      };
      noteSaved(await api.saveNpExpiring(contractId, expPayload, requestOptions()));
      dirty.current = false;
      return true;
    } catch (e) {
      logger.error('[NpStructure] save failed:', e);
      if (lockOverride !== '*') {
        const stale = await handleStaleWriteTyped(e, {
          entityType: isQuoteSave ? 'quote structure' : 'structure',
          onRefresh: () => window.location.reload(),
          onOverwrite: () => save({ ifUnmodifiedSince: '*' }),
        });
        if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      }
      showToast('Structure save failed: ' + ((e as Error)?.message || 'Server error'));
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dependency contract carried over verbatim from the pre-refactor screen
  }, [contractId, quoteMode, lastUpdatedAt, coveredProps, structuresCount, structRefsMap, layers, cobRows, expiringLayers, expiringTerms.egnpi, expiringTerms.deductible, expiringTerms.risk_limit, expiringTerms.cat_limit, expiringTerms.brokerage_pct, expiringTerms.no_claims_bonus_pct, expiringTerms.profit_commission_pct, expiringTerms.notes, expiringCoveredProps, showToast, appState.npStopLossInputs, appState.npAggregateXlInputs, appState.npStopLossExpiring]);

  /* ── Peril-mode display flags ──
     RISK: risk forced on, cat forced off, both columns disabled
     CAT:  cat forced on, risk forced off, both columns disabled
     BOTH: both editable (default on)
     '' (Stop Loss, Excess of Loss, Aggregate XL): both editable (default on) */
  const riskLocked = mode === 'RISK' || mode === 'CAT';
  const catLocked  = mode === 'RISK' || mode === 'CAT';
  const riskPillOn = mode === 'RISK' || mode === 'BOTH';
  const catPillOn  = mode === 'CAT'  || mode === 'BOTH';

  // Shared with the final-pricing quote panel + pricing-analysis modal so every
  // NP reinstatement dropdown offers the same blank / 1–10 / Unlimited choices.
  const reinstatementOptions = REINSTATEMENT_OPTIONS;

  // Stop Loss + Aggregate XL each have their own structure surfaces
  // (different shapes from the Risk XL / Cat XL layer grid). The
  // orchestrator short-circuits the regular layout for them.
  const stopLossTreaty = isNpStopLossTreaty(appState);
  const aggregateXlTreaty = isNpAggregateXlTreaty(appState);

  return {
    // store state
    layers, cobRows, coveredProps, cobOptions, savedQuoteStructures, loading,
    expiringLayerCount, expiringLayers, expiringTerms, isRenewal,
    expiringAutoPopulated, expiringCoveredProps, showExpCurveModal,
    // derived
    quoteMode, mode, currency, structuresCount, isNetXl,
    riskLocked, catLocked, riskPillOn, catPillOn,
    reinstatementOptions, stopLossTreaty, aggregateXlTreaty,
    coveredPropsCalc, expiringCoveredPropsCalc,
    // callbacks
    updateStructuresCount, updateLayer, addLayer, deleteLastLayer,
    handleLayerPaste, handleExpiringPaste,
    updateCobRow, toggleCobLayer, updateCoveredProp,
    updateExpiringLayer, updateExpiringTerm, enableExpiringOverride,
    updateExpiringCoveredProp, addExpiringCoveredProp, removeExpiringCoveredProp,
    setShowExpCurveModal, markDirty, save,
  };
}

export default useNpStructureState;
