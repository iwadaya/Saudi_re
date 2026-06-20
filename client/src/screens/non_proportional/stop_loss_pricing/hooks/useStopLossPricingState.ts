// hooks/useStopLossPricingState.ts — all state, effects, derived pricing
// pipeline and persistence for the NP Stop Loss Pricing screen (Phase 4.2
// decomposition of NpStopLossPricing.jsx).
//
// The orchestrator (NpStopLossPricing.jsx) renders; this hook owns:
//   • the working inputs (DEFAULT_INPUTS merged over the AppContext slice
//     `npStopLossInputs` — session-local, shared with the Structure page)
//   • the premiums + rate-changes load from the relational EGNPI table
//   • the derived pipeline (yearRange → yearlyRows → burningCostRows →
//     per-layer engine args → priceStopLoss results → outputs snapshot)
//   • server persistence via useScreenSave (PUT /api/{treaties|quotes}/
//     :id/np/stop-loss-pricing)
//
// Every memo body, dependency array and effect was carried over verbatim
// from the pre-refactor screen (pure pieces live in
// state/stopLossPricingState.ts) — goldenMaster.test.jsx pins the
// observable behaviour. The npStopLossInputs slice write points are
// preserved exactly: setSlice on every edit (setInput), replaceSlice only
// on server hydration with the merge-under-current + legacy-shape
// migration — the Structure page owns the layer fields in that slice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import api from '../../../../api';
import { useAppState } from '../../../../context/AppContext';
import { useContractId } from '../../../../hooks/useContractId';
import { useScreenSave } from '../../../../hooks/useScreenSave';
import { priceStopLoss } from '../../../../logic/stopLossPricing';
import type { StopLossPricingBundle } from '../../../../types/pricing';
import { logger } from '../../../../utils/logger';
import {
  SLICE_KEY,
  DEFAULT_INPUTS,
  EMPTY_PREMIUM_DATA,
  EMPTY_RESULT,
  buildBurningCostRows,
  buildLayerCount,
  buildLayerEngineArgs,
  buildLayers,
  buildOutputsSnapshot,
  buildSharedEngineArgs,
  buildYearRange,
  buildYearlyRows,
  mergeLoadedInputs,
  parseEgnpiRows,
} from '../state/stopLossPricingState';
import type {
  BurningCostRow,
  NormalizedLayer,
  PremiumData,
  StopLossInputs,
  StopLossResult,
  YearAggregateRow,
} from '../state/stopLossPricingState';

export interface UseStopLossPricingStateResult {
  /** DEFAULT_INPUTS merged over the npStopLossInputs slice. */
  inputs: StopLossInputs;
  /** Patch engine inputs into the slice + mark the screen dirty. */
  setInput: (patch: Record<string, unknown>) => void;
  /** Layer cover rows (read-only here; owned by the Structure page). */
  layers: NormalizedLayer[];
  layerCount: number;
  /** priceStopLoss output per layer (same order as `layers`). */
  layerResults: StopLossResult[];
  /** Layer 1 — the canonical "primary cover" for the summary cards. */
  result: StopLossResult;
  /** On-level premium / loss-ratio rows for the burning-cost table. */
  burningCostRows: BurningCostRow[];
  setYearAggregate: (year: number, raw: string) => void;
  handleAggregatePaste: (e: ReactClipboardEvent<HTMLInputElement>, startIdx: number) => void;
  /** Wizard-compatible save (true on success / no-op, false on failure). */
  save: () => Promise<boolean>;
}

export function useStopLossPricingState(): UseStopLossPricingStateResult {
  const { state: appState, setSlice, replaceSlice } = useAppState();
  const contractId = useContractId();
  const apiOpts = useMemo(
    () => (appState.quoteMode ? { quote: true } : undefined),
    [appState.quoteMode],
  );
  const inputs = useMemo(
    () => ({ ...DEFAULT_INPUTS, ...(appState[SLICE_KEY] || {}) }) as StopLossInputs,
    [appState],
  );

  // markDirtyRef + inputsRef declared up here so setInput can close
  // over them safely. inputsRef.current is kept in sync below.
  const markDirtyRef = useRef<null | (() => void)>(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  // Live snapshot of the raw slice (without DEFAULT_INPUTS merged in)
  // so the server-hydration callback can tell which fields were
  // populated by the Structure page vs which are still defaults.
  const sliceRef = useRef<Record<string, unknown> | undefined>(appState[SLICE_KEY]);
  sliceRef.current = appState[SLICE_KEY];

  // Seed the yearly-aggregates table from the underwriting year range
  // when the user first lands here. Empty aggregates are kept so the
  // burning-cost denominator includes zero-loss years (see annualiseLoss).
  const yearRange = useMemo(
    () => buildYearRange(appState.npTreatyDetail || {}),
    [appState.npTreatyDetail],
  );

  const yearlyRows = useMemo(
    () => buildYearlyRows(yearRange, inputs.yearlyAggregates),
    [yearRange, inputs.yearlyAggregates],
  );

  const setInput = useCallback(
    (patch: Record<string, unknown>) => {
      // The Pricing screen only edits engine inputs (frequency,
      // severity, MC, weights, loading, yearly aggregates). Layer
      // cover fields (attachmentLossRatio / limitLossRatio / epi)
      // are read-only here — those are owned by the Structure page.
      setSlice(SLICE_KEY, patch);
      markDirtyRef.current?.();
    },
    [setSlice],
  );

  // ── Pull premiums + rate changes from the relational EGNPI table so
  //    the burning cost can compute on-level adjusted premiums and LRs.
  const [premiumData, setPremiumData] = useState<PremiumData>(EMPTY_PREMIUM_DATA);
  useEffect(() => {
    if (!contractId || typeof api.getNpEgnpiYear !== 'function') return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.getNpEgnpiYear(contractId, apiOpts);
        if (cancelled) return;
        setPremiumData(parseEgnpiRows(rows));
      } catch (err) {
        // Premiums missing is fine — burning cost just won't compute LRs.
        if (!cancelled) logger.warn('[NpStopLossPricing] egnpi-year load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [contractId, apiOpts]);

  // ── Server persistence via useScreenSave ──
  const loadStopLoss = useCallback(
    (id: string) => api.getNpStopLossPricing(id, apiOpts),
    [apiOpts],
  );
  const persist = useCallback(
    (id: string, payload: unknown) => api.saveNpStopLossPricing(id, payload, apiOpts),
    [apiOpts],
  );
  const onLoaded = useCallback(
    (data: Partial<StopLossPricingBundle> | null | undefined) => {
      // Server returns { inputs, outputs, updated_at }. Merge it UNDER
      // the live slice (Structure-page fields win) and migrate legacy
      // flat snapshots to the layers[] shape — see mergeLoadedInputs.
      // When the server had nothing saved the slice is left untouched.
      const merged = mergeLoadedInputs(data, sliceRef.current);
      if (merged) replaceSlice(SLICE_KEY, merged);
    },
    [replaceSlice],
  );

  const setYearAggregate = useCallback(
    (year: number, raw: string) => {
      const next = yearlyRows.map((r): YearAggregateRow =>
        r.year === year ? { year, aggregate: raw } : { year: r.year, aggregate: r.aggregate },
      );
      setInput({ yearlyAggregates: next });
    },
    [yearlyRows, setInput],
  );

  // Excel paste handler for the burning-cost table. Accepts a single
  // column of values (newline-separated) and fills consecutive years
  // downward starting from the pasted row. A pasted block with more
  // values than remaining years is truncated; single-cell pastes still
  // strip non-numeric characters (so "1,250,000" pastes as 1250000).
  const handleAggregatePaste = useCallback(
    (e: ReactClipboardEvent<HTMLInputElement>, startIdx: number) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      // Excel column copy uses CRLF or LF between cells; we tolerate
      // either. Tab-separated rows are flattened by taking only the
      // first column — pricing data is one number per year, not a grid.
      const values = text
        .split(/[\r\n]+/)
        .map((line) => String(line.split('\t')[0] || '').trim())
        .filter((s) => s.length > 0);
      if (values.length === 0) return;
      e.preventDefault();
      const next = yearlyRows.map((r): YearAggregateRow => ({ year: r.year, aggregate: r.aggregate }));
      for (let i = 0; i < values.length && startIdx + i < next.length; i++) {
        // Strip currency / comma formatting; leave a bare numeric string
        // so the same code path as keyboard input cleans it via toN().
        const cleaned = values[i].replace(/[^0-9.\-eE]/g, '');
        next[startIdx + i] = { year: next[startIdx + i].year, aggregate: cleaned };
      }
      setInput({ yearlyAggregates: next });
    },
    [yearlyRows, setInput],
  );

  // ── On-level burning cost rows ──
  // Compose Premium (adjusted), Aggregate Loss, Loss Ratio, and the
  // normalised aggregate (LR × current_EPI) we feed to the engine.
  const burningCostRows = useMemo(
    () => buildBurningCostRows(yearRange, yearlyRows, premiumData),
    [yearRange, yearlyRows, premiumData],
  );

  // ── Build the layers array. Sourced from the Structure page (which
  //    writes to `inputs.layers`); falls back to the legacy top-level
  //    attachment/limit/epi as layer 0 for records saved before the
  //    layers refactor. Pad / truncate to the count on Treaty Detail so
  //    both screens stay in lock-step.
  const layerCount = useMemo(
    () => buildLayerCount(appState.npTreatyDetail || {}),
    [appState.npTreatyDetail],
  );

  const layers = useMemo(
    () => buildLayers(inputs.layers, layerCount),
    [inputs.layers, layerCount],
  );

  // ── Shared engine args (frequency / severity / MC / blend / loading).
  const sharedEngineArgs = useMemo(() => buildSharedEngineArgs(inputs), [inputs]);

  const layerEngineArgs = useMemo(
    () => buildLayerEngineArgs(layers, sharedEngineArgs, burningCostRows),
    [layers, sharedEngineArgs, burningCostRows],
  );

  // Per-layer results. priceStopLoss runs once per layer; MC simulations
  // therefore re-roll per layer with the same seed so layer-to-layer
  // comparisons stay deterministic.
  const layerResults = useMemo(
    () => layerEngineArgs.map((args) => priceStopLoss(args)),
    [layerEngineArgs],
  );

  // Layer 1 is the canonical "primary cover" used for the burning-cost
  // table's per-year LR view and for the existing single-layer
  // exposure-rating / MC summary cards. Per-layer headline numbers
  // (annual loss, ROL, premium) are shown together in the Result table.
  const result = useMemo(
    () => layerResults[0] || EMPTY_RESULT,
    [layerResults],
  );

  // Snapshot the result for the persist payload. Top-level fields keep
  // the layer-1 view (back-compat); `layers` carries the per-layer
  // headline numbers so the saved record matches what the user sees on
  // screen for multi-layer covers.
  const outputsSnapshot = useMemo(
    () => buildOutputsSnapshot(result, layerResults),
    [result, layerResults],
  );

  const currentState = useCallback(
    // StopLossInputs carries `unknown` layer fields, so it does not
    // structurally satisfy Record<string, JsonValue> — the wire shape is
    // unchanged from the pre-refactor screen, hence the two-step cast.
    () => ({ inputs: inputsRef.current, outputs: outputsSnapshot }) as unknown as Partial<StopLossPricingBundle>,
    [outputsSnapshot],
  );

  const { save, markDirty } = useScreenSave({
    entityId: contractId || '',
    load: loadStopLoss,
    save: persist,
    currentState,
    onLoaded,
    errorLabel: 'Stop loss pricing',
    reloadDeps: [apiOpts],
  });
  markDirtyRef.current = markDirty;

  return {
    inputs,
    setInput,
    layers,
    layerCount,
    layerResults,
    result,
    burningCostRows,
    setYearAggregate,
    handleAggregatePaste,
    save,
  };
}

export default useStopLossPricingState;
