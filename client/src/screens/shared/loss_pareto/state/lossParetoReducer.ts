// loss_pareto/state/lossParetoReducer.ts — typed screen state for
// LossParetoScreen (Phase 4.2 decomposition).
//
// One reducer replaces the screen's 21 useState atoms. Each action maps
// 1:1 onto an original setter call so the migration is mechanical and the
// golden master (LossParetoScreen.goldenMaster.test.jsx) stays byte-identical:
// no recompute, reload, or save-lifecycle semantics changed.
//
// NumericLike caution (types/pricing.ts): hydration values restored from a
// saved snapshot are stored UNTOUCHED, exactly as the old setters did — a
// Postgres NUMERIC column can arrive as a string and every downstream
// consumer already coerces (cn()/Number()) or compares loosely. The reducer
// must never add Number() coercions of its own.

/** One loss row after the fetcher's parse step (inflated derived, > 0). */
export interface ParetoLossRow {
  inflated: number;
  incurred: number;
  loss_id?: string;
  uw_year?: number | string | null;
  insured_name?: string | null;
  loss_name?: string | null;
  date_of_loss?: string | null;
  class_of_business?: string | null;
  paid?: unknown;
  os?: unknown;
  inflation_factor?: unknown;
  [extra: string]: unknown;
}

/** Editable RP-curve row: raw input strings, parsed only at use sites. */
export interface RpCurveRow { rp: string; loss: string }

export type RpSourceSelection = 'FITTED' | 'TP' | 'BLEND';

export interface PortfolioFallback { treatyCount: number }

export interface LossParetoState {
  losses: ParetoLossRow[];
  /** Set when the curve is fitted to cedant-portfolio losses instead of the treaty's own. */
  portfolioFallback: PortfolioFallback | null;
  loading: boolean;
  /** Pareto threshold (xm). */
  xm: number;
  /** Treaty/structure limit used for over-limit flags and the default layer. */
  limit: number;
  /** Fitted (or overridden) Pareto alpha. */
  alpha: number;
  /** Active distribution key; free string because snapshots may carry anything. */
  activeDist: string;
  /** Frequency–severity modal visibility. */
  showChart: boolean;
  /** Observation-years override (raw input string; '' = default 10). */
  yearsOvr: string;
  saving: boolean;
  saveError: string | null;
  savedSnapshotId: string | null;
  lastSaveTime: Date | null;
  /** Third-party RP comparison (CAT only). */
  tpRows: RpCurveRow[];
  tpSource: string;
  rpSource: RpSourceSelection;
  /** % fitted in the blend (0–100). */
  rpBlend: number;
  rpCompareOpen: boolean;
  /** Cat-model OEP curve input rows. */
  oepRows: RpCurveRow[];
  showOep: boolean;
  /** Layer burning cost blend weights (0–100 each). */
  wEmp: number;
  wModel: number;
}

/** Snapshot-restore patch: only the fields the snapshot actually carried. */
export type SnapshotHydrationPatch = Partial<
  Pick<
    LossParetoState,
    | 'xm'
    | 'limit'
    | 'alpha'
    | 'yearsOvr'
    | 'activeDist'
    | 'wEmp'
    | 'wModel'
    | 'oepRows'
    | 'tpRows'
    | 'tpSource'
    | 'rpSource'
    | 'rpBlend'
    | 'savedSnapshotId'
  >
>;

export type LossParetoAction =
  /* ── load lifecycle ── */
  | { type: 'LOSSES_LOADED'; losses: ParetoLossRow[]; portfolioFallback: PortfolioFallback | null }
  | { type: 'SNAPSHOT_HYDRATED'; patch: SnapshotHydrationPatch }
  /** No-snapshot default: xm = prev || payload (keeps a user-typed xm). */
  | { type: 'XM_DEFAULTED'; xm: number }
  | { type: 'LOAD_DONE' }
  /* ── threshold / fit parameter edits (Parameters card + refit effect) ── */
  | { type: 'SET_XM'; xm: number }
  | { type: 'SET_LIMIT'; limit: number }
  | { type: 'SET_ALPHA'; alpha: number }
  | { type: 'SET_YEARS_OVR'; yearsOvr: string }
  | { type: 'SET_ACTIVE_DIST'; dist: string }
  /* ── modal toggles ── */
  | { type: 'SET_SHOW_CHART'; open: boolean }
  | { type: 'SET_RP_COMPARE_OPEN'; open: boolean }
  | { type: 'TOGGLE_OEP' }
  /* ── layer burning cost weights ── */
  | { type: 'SET_WEIGHTS'; wEmp?: number; wModel?: number }
  /* ── OEP curve input edits ── */
  | { type: 'SET_OEP_ROW'; index: number; field: 'rp' | 'loss'; value: string }
  /* ── third-party RP comparison apply ── */
  | { type: 'APPLY_TP'; tpRows: RpCurveRow[]; tpSource: string; rpSource: RpSourceSelection; rpBlend: number }
  /* ── save lifecycle ── */
  | { type: 'SAVE_STARTED' }
  | { type: 'SAVE_SUCCEEDED'; at: Date }
  | { type: 'SAVE_FAILED'; error: string };

export function createDefaultOepRows(): RpCurveRow[] {
  return [2, 5, 10, 25, 50, 100, 200, 250, 500].map((rp) => ({ rp: String(rp), loss: '' }));
}

export function createInitialLossParetoState(): LossParetoState {
  return {
    losses: [],
    portfolioFallback: null,
    loading: true,
    xm: 0,
    limit: 0,
    alpha: 0,
    activeDist: 'pareto',
    showChart: false,
    yearsOvr: '',
    saving: false,
    saveError: null,
    savedSnapshotId: null,
    lastSaveTime: null,
    tpRows: [],
    tpSource: '',
    rpSource: 'FITTED',
    rpBlend: 50,
    rpCompareOpen: false,
    oepRows: createDefaultOepRows(),
    showOep: false,
    wEmp: 50,
    wModel: 50,
  };
}

export function lossParetoReducer(state: LossParetoState, action: LossParetoAction): LossParetoState {
  switch (action.type) {
    case 'LOSSES_LOADED':
      return { ...state, losses: action.losses, portfolioFallback: action.portfolioFallback };
    case 'SNAPSHOT_HYDRATED':
      return { ...state, ...action.patch };
    case 'XM_DEFAULTED':
      // Mirrors the old setXm(prev => prev || vals[0]).
      return state.xm ? state : { ...state, xm: action.xm };
    case 'LOAD_DONE':
      return state.loading ? { ...state, loading: false } : state;
    case 'SET_XM':
      return { ...state, xm: action.xm };
    case 'SET_LIMIT':
      return { ...state, limit: action.limit };
    case 'SET_ALPHA':
      return { ...state, alpha: action.alpha };
    case 'SET_YEARS_OVR':
      return { ...state, yearsOvr: action.yearsOvr };
    case 'SET_ACTIVE_DIST':
      return { ...state, activeDist: action.dist };
    case 'SET_SHOW_CHART':
      return { ...state, showChart: action.open };
    case 'SET_RP_COMPARE_OPEN':
      return { ...state, rpCompareOpen: action.open };
    case 'TOGGLE_OEP':
      return { ...state, showOep: !state.showOep };
    case 'SET_WEIGHTS':
      return {
        ...state,
        ...(action.wEmp !== undefined ? { wEmp: action.wEmp } : null),
        ...(action.wModel !== undefined ? { wModel: action.wModel } : null),
      };
    case 'SET_OEP_ROW': {
      const next = [...state.oepRows];
      const row = next[action.index];
      if (!row) return state;
      next[action.index] = { ...row, [action.field]: action.value };
      return { ...state, oepRows: next };
    }
    case 'APPLY_TP':
      return {
        ...state,
        tpRows: action.tpRows,
        tpSource: action.tpSource,
        rpSource: action.rpSource,
        rpBlend: action.rpBlend,
      };
    case 'SAVE_STARTED':
      return { ...state, saving: true, saveError: null };
    case 'SAVE_SUCCEEDED':
      return { ...state, saving: false, lastSaveTime: action.at };
    case 'SAVE_FAILED':
      return { ...state, saving: false, saveError: action.error };
    default:
      return state;
  }
}

export default lossParetoReducer;
