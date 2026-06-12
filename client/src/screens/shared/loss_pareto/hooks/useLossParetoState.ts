// loss_pareto/hooks/useLossParetoState.ts — reducer wiring for
// LossParetoScreen (Phase 4.2). Exposes the typed state plus a STABLE
// `actions` object (identity never changes) so effects in the data /
// save hooks can list it as a dependency without re-running.

import { useMemo, useReducer } from 'react';
import {
  createInitialLossParetoState,
  lossParetoReducer,
  type LossParetoState,
  type ParetoLossRow,
  type PortfolioFallback,
  type RpCurveRow,
  type RpSourceSelection,
  type SnapshotHydrationPatch,
} from '../state/lossParetoReducer';

export interface LossParetoActions {
  lossesLoaded: (losses: ParetoLossRow[], portfolioFallback: PortfolioFallback | null) => void;
  snapshotHydrated: (patch: SnapshotHydrationPatch) => void;
  xmDefaulted: (xm: number) => void;
  loadDone: () => void;
  setXm: (xm: number) => void;
  setLimit: (limit: number) => void;
  setAlpha: (alpha: number) => void;
  setYearsOvr: (yearsOvr: string) => void;
  setActiveDist: (dist: string) => void;
  setShowChart: (open: boolean) => void;
  setRpCompareOpen: (open: boolean) => void;
  toggleOep: () => void;
  setWeights: (weights: { wEmp?: number; wModel?: number }) => void;
  setOepRow: (index: number, field: 'rp' | 'loss', value: string) => void;
  applyTp: (payload: { tpRows: RpCurveRow[]; tpSource: string; rpSource: RpSourceSelection; rpBlend: number }) => void;
  saveStarted: () => void;
  saveSucceeded: (at: Date) => void;
  saveFailed: (error: string) => void;
}

export function useLossParetoState(): { state: LossParetoState; actions: LossParetoActions } {
  const [state, dispatch] = useReducer(lossParetoReducer, undefined, createInitialLossParetoState);

  // dispatch from useReducer is referentially stable, so this memo never
  // re-creates and `actions` is safe to use in effect dependency arrays.
  const actions = useMemo<LossParetoActions>(() => ({
    lossesLoaded: (losses, portfolioFallback) => dispatch({ type: 'LOSSES_LOADED', losses, portfolioFallback }),
    snapshotHydrated: (patch) => dispatch({ type: 'SNAPSHOT_HYDRATED', patch }),
    xmDefaulted: (xm) => dispatch({ type: 'XM_DEFAULTED', xm }),
    loadDone: () => dispatch({ type: 'LOAD_DONE' }),
    setXm: (xm) => dispatch({ type: 'SET_XM', xm }),
    setLimit: (limit) => dispatch({ type: 'SET_LIMIT', limit }),
    setAlpha: (alpha) => dispatch({ type: 'SET_ALPHA', alpha }),
    setYearsOvr: (yearsOvr) => dispatch({ type: 'SET_YEARS_OVR', yearsOvr }),
    setActiveDist: (dist) => dispatch({ type: 'SET_ACTIVE_DIST', dist }),
    setShowChart: (open) => dispatch({ type: 'SET_SHOW_CHART', open }),
    setRpCompareOpen: (open) => dispatch({ type: 'SET_RP_COMPARE_OPEN', open }),
    toggleOep: () => dispatch({ type: 'TOGGLE_OEP' }),
    setWeights: ({ wEmp, wModel }) => dispatch({ type: 'SET_WEIGHTS', wEmp, wModel }),
    setOepRow: (index, field, value) => dispatch({ type: 'SET_OEP_ROW', index, field, value }),
    applyTp: ({ tpRows, tpSource, rpSource, rpBlend }) => dispatch({ type: 'APPLY_TP', tpRows, tpSource, rpSource, rpBlend }),
    saveStarted: () => dispatch({ type: 'SAVE_STARTED' }),
    saveSucceeded: (at) => dispatch({ type: 'SAVE_SUCCEEDED', at }),
    saveFailed: (error) => dispatch({ type: 'SAVE_FAILED', error }),
  }), []);

  return { state, actions };
}

export default useLossParetoState;
