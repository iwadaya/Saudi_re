// state/propPricingReducer.ts — Phase 4.2 (docs/frontend-hardening.md).
//
// The single strict-typed reducer that replaced PropPricing's 44 useState
// calls. State is grouped into coherent slices (grid, workflow, modals,
// saveLifecycle, ui, refData); every transition is a mechanical slice-key
// set with React.useState's exact bail-out semantics, plus one
// 'contract/reset' transition whose key list is the screen's
// reset-on-contract-change effect moved VERBATIM. The golden-master suite
// (PropPricing.goldenMaster.test.jsx) pins the observable outputs; if an
// edit here changes one of its expectations, the edit changed pricing
// behaviour.
//
// Typing notes (the NumericLike trap, client/src/types/pricing.ts): the
// component grid stores formatted strings ("35.00%") but server hydration
// can inject raw numbers — cells are typed NumericLike, never number.
// Wire-shaped server bags (contract bundle, share-scenario rows, yearly
// rows…) stay AnyRecord at this boundary, exactly the dynamic shapes the
// untyped screen consumed.

import { DEFAULT_SHARE_ROWS } from '../components/propPricingConstants.js';

/** Formatted strings stay strings; server merges may inject numbers. */
export type NumericLike = string | number;
/** Wire-shaped server/JSONB bag the screen reads dynamically. */
export type AnyRecord = Record<string, any>;

/** One component-table row: actuarial/uw/market/actual/exposure/downside/comment. */
export type ComponentCell = Record<string, NumericLike>;
/** The component pricing grid keyed by row label ("Attritional Loss Ratio"…). */
export type ComponentsGrid = Record<string, ComponentCell>;
/** Share-scenario grid keyed by share label ("1%", "2.5%", "5%", "100%"). */
export type ShareGrid = Record<string, AnyRecord>;

export interface SaveMsg { type: 'ok' | 'err'; text: string }
export interface WorstLR { lr: number | null; year: string }

export interface GridSlice {
  components: ComponentsGrid;
  /**
   * Rows whose UW cell the user has explicitly edited — these are no
   * longer re-seeded from the actuarial column when it re-calculates.
   */
  uwUserEdited: Set<string>;
  leads: AnyRecord;
  shareRows: string[];
  shareGrid: ShareGrid;
  yearly: AnyRecord[];
  comment: string;
  snapshots: AnyRecord[];
  snapLabel: string;
}

export interface WorkflowSlice {
  offerStatus: string;
  offerLine: string;
  offerComment: string;
  offerApprover: string;
  eligibleApprovers: AnyRecord[];
  returnReason: string;
  declineReason: string;
  approvalTrail: AnyRecord[];
  signedLinePct: string;
}

export interface ModalsSlice {
  showDecline: boolean;
  showOffer: boolean;
  showMandateBlock: boolean;
  showQuickSummary: boolean;
  showMarketIntelligence: boolean;
  showAggBreakdown: boolean;
  showInDepth: boolean;
  showAggDrilldown: boolean;
  showSnapHistory: boolean;
  insightOpen: boolean;
  insightKey: string;
}

export interface SaveLifecycleSlice {
  dirty: boolean;
  saveMsg: SaveMsg | null;
  /** Optimistic-lock token from the last load/save response. */
  lastUpdatedAt: string | null;
}

export interface UiSlice {
  loading: boolean;
  showUSD: boolean;
  /** Set when the main pricing load fails (network / 5xx) so the screen can
   *  show a retry panel instead of a blank pricing surface. */
  error: unknown;
}

export interface RefDataSlice {
  contract: AnyRecord;
  reinsurers: AnyRecord[];
  fxRates: Record<string, number>;
  contractAgg100: number | null;
  otherCountryAgg: number | null;
  cobLabel: string;
  worstLR: WorstLR;
  /**
   * True when pricing fell back to placeholder benchmark curves (no saved
   * pricing rows, no saved factors, no triangle, no saved blend).
   */
  usedPlaceholderLdfs: boolean;
  /** True when large/cat losses were edited after the loss selection was saved. */
  lossStale: boolean;
}

export interface PropPricingState {
  grid: GridSlice;
  workflow: WorkflowSlice;
  modals: ModalsSlice;
  saveLifecycle: SaveLifecycleSlice;
  ui: UiSlice;
  refData: RefDataSlice;
}

export function createInitialPropPricingState(): PropPricingState {
  return {
    grid: {
      components: {},
      uwUserEdited: new Set(),
      leads: {},
      shareRows: DEFAULT_SHARE_ROWS.slice(),
      shareGrid: {},
      yearly: [],
      comment: '',
      snapshots: [],
      snapLabel: '',
    },
    workflow: {
      offerStatus: 'DRAFT',
      offerLine: '',
      offerComment: '',
      offerApprover: '',
      eligibleApprovers: [],
      returnReason: '',
      declineReason: '',
      approvalTrail: [],
      signedLinePct: '',
    },
    modals: {
      showDecline: false,
      showOffer: false,
      showMandateBlock: false,
      showQuickSummary: false,
      showMarketIntelligence: false,
      showAggBreakdown: false,
      showInDepth: false,
      showAggDrilldown: false,
      showSnapHistory: false,
      insightOpen: false,
      insightKey: '',
    },
    saveLifecycle: {
      dirty: false,
      saveMsg: null,
      lastUpdatedAt: null,
    },
    ui: {
      loading: true,
      showUSD: false,
      error: null,
    },
    refData: {
      contract: {},
      reinsurers: [],
      fxRates: {},
      contractAgg100: null,
      otherCountryAgg: null,
      cobLabel: '',
      worstLR: { lr: null, year: '' },
      usedPlaceholderLdfs: false,
      lossStale: false,
    },
  };
}

/** useState-compatible setter argument: a value or a functional updater. */
export type Setter<T> = T | ((prev: T) => T);

type SliceSetAction<N extends string, S> = {
  [K in keyof S & string]: { type: `${N}/set`; key: K; next: Setter<S[K]> };
}[keyof S & string];

export type PropPricingAction =
  | SliceSetAction<'grid', GridSlice>
  | SliceSetAction<'workflow', WorkflowSlice>
  | SliceSetAction<'modals', ModalsSlice>
  | SliceSetAction<'saveLifecycle', SaveLifecycleSlice>
  | SliceSetAction<'ui', UiSlice>
  | SliceSetAction<'refData', RefDataSlice>
  // ── contract switch: reset local state exactly like the legacy effect ──
  | { type: 'contract/reset' };

const applySetter = <T,>(prev: T, next: Setter<T>): T => (
  typeof next === 'function' ? (next as (p: T) => T)(prev) : next
);

// Generic slice-key setter with the same bail-out semantics as
// React.useState: an Object.is-identical value leaves state untouched.
function setSliceKey<S extends object>(slice: S, key: keyof S, next: Setter<S[keyof S]>): S {
  const value = applySetter(slice[key], next);
  if (Object.is(value, slice[key])) return slice;
  return { ...slice, [key]: value };
}

function withSlice<K extends keyof PropPricingState>(
  state: PropPricingState,
  name: K,
  nextSlice: PropPricingState[K],
): PropPricingState {
  if (nextSlice === state[name]) return state;
  return { ...state, [name]: nextSlice };
}

/**
 * The reset-on-contract-change transition. Key list and values are the
 * screen's original effect body moved VERBATIM — keys it did NOT touch
 * (eligibleApprovers, approvalTrail, returnReason, declineReason,
 * snapshots, snapLabel, cobLabel, fxRates, aggregates, worstLR, banners
 * and the remaining modal flags) deliberately survive the switch exactly
 * as they did before.
 */
function resetForContractSwitch(state: PropPricingState): PropPricingState {
  return {
    ...state,
    ui: { ...state.ui, loading: true, showUSD: false, error: null },
    saveLifecycle: { ...state.saveLifecycle, dirty: false, saveMsg: null, lastUpdatedAt: null },
    refData: { ...state.refData, contract: {}, reinsurers: [] },
    grid: {
      ...state.grid,
      components: {},
      uwUserEdited: new Set(),
      leads: {},
      shareRows: DEFAULT_SHARE_ROWS.slice(),
      shareGrid: {},
      yearly: [],
      comment: '',
    },
    workflow: {
      ...state.workflow,
      offerLine: '',
      offerComment: '',
      offerApprover: '',
      offerStatus: 'DRAFT',
      signedLinePct: '',
    },
    modals: { ...state.modals, showOffer: false, showDecline: false, insightOpen: false },
  };
}

export function propPricingReducer(
  state: PropPricingState,
  action: PropPricingAction,
): PropPricingState {
  switch (action.type) {
    case 'grid/set':
      return withSlice(state, 'grid', setSliceKey(state.grid, action.key, action.next as Setter<GridSlice[keyof GridSlice]>));
    case 'workflow/set':
      return withSlice(state, 'workflow', setSliceKey(state.workflow, action.key, action.next as Setter<WorkflowSlice[keyof WorkflowSlice]>));
    case 'modals/set':
      return withSlice(state, 'modals', setSliceKey(state.modals, action.key, action.next as Setter<ModalsSlice[keyof ModalsSlice]>));
    case 'saveLifecycle/set':
      return withSlice(state, 'saveLifecycle', setSliceKey(state.saveLifecycle, action.key, action.next as Setter<SaveLifecycleSlice[keyof SaveLifecycleSlice]>));
    case 'ui/set':
      return withSlice(state, 'ui', setSliceKey(state.ui, action.key, action.next as Setter<UiSlice[keyof UiSlice]>));
    case 'refData/set':
      return withSlice(state, 'refData', setSliceKey(state.refData, action.key, action.next as Setter<RefDataSlice[keyof RefDataSlice]>));
    case 'contract/reset':
      return resetForContractSwitch(state);
    default:
      return state;
  }
}

export default propPricingReducer;
