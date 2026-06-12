// state/pricingState.ts — Phase 4.1 (docs/frontend-hardening.md).
//
// The honestly-typed state model + action contract for NpFinalPricing,
// consumed by state/pricingReducer.ts (transitions) and
// hooks/useNpPricingState.ts (the useReducer wrapper). Formatted strings
// stay strings (NumericLike) — see the NumericLike trap notes in
// client/src/types/pricing.ts.

import { emptyExpLayer } from '../fqQuoteMath.js';

/** Treaty-type peril flags that drive blank-layer risk/cat defaults. */
export interface PerilDefaults { riskDisabled: boolean; catDisabled: boolean }

export type NumericLike = string | number;

/** One pricing layer row (treaty mode). Formatted strings stay strings. */
export interface LayerPricing {
  layer: string;
  limit: NumericLike;
  deductible: NumericLike;
  risk: boolean;
  cat: boolean;
  riskPureBurn: NumericLike;
  riskPareto: NumericLike;
  riskAvgBurnPareto: NumericLike;
  riskExposure: NumericLike;
  riskWeightBurn: NumericLike;
  riskWeightPareto: NumericLike;
  riskWeightExposure: NumericLike;
  riskLoading: NumericLike;
  riskTotalPrice: NumericLike;
  riskUwPrice: NumericLike;
  riskPrAttach: NumericLike;
  riskPrExhaust: NumericLike;
  catPureBurn: NumericLike;
  catPareto: NumericLike;
  catAvgBurnPareto: NumericLike;
  catExposure: NumericLike;
  catWeightBurn: NumericLike;
  catWeightPareto: NumericLike;
  catWeightExposure: NumericLike;
  catLoading: NumericLike;
  catTotalPrice: NumericLike;
  catUwPrice: NumericLike;
  catPrAttach: NumericLike;
  catPrExhaust: NumericLike;
  totalPrice: NumericLike;
  uwPrice: NumericLike;
  reinsurerPricing: NumericLike;
  leadPricing: NumericLike;
  expiringPricing: NumericLike;
  historicalMargin: NumericLike;
  reinsurerMarginVsLead: NumericLike;
  reinsurerMargin: NumericLike;
  technicalRatio: NumericLike;
  share: NumericLike;
  classOfBusinessIds?: Array<string | number>;
  /** Server merges spread extra relational/JSONB fields onto the row. */
  [extra: string]: unknown;
}

export interface LeadSetupRow {
  leader: string;
  expiringReinsurer: string;
  rol: NumericLike;
  leadShare: NumericLike;
  [extra: string]: unknown;
}

/** Opaque server/JSONB-shaped rows the screen passes through untouched. */
export type LooseRecord = Record<string, unknown>;
/** Quote-mode draft layer — stringly user input plus risk/cat flags. */
export type QuoteLayerDraft = LooseRecord;
export interface QuoteStructureDraft {
  id: string;
  layers: QuoteLayerDraft[];
  [extra: string]: unknown;
}
export interface SelectedCob { id: string | number; name: string; uwLimit: string }

export interface LayersSlice {
  layers: LayerPricing[];
  leadSetup: LeadSetupRow[];
  /** Structure layers loaded from the server (not just AppContext). */
  localStructureLayers: LooseRecord[];
  /** Technical-analysis metric cells, e.g. ded_pct_cover_prev → "22.50%". */
  treatyMetrics: Record<string, string>;
  cobUwLimits: LooseRecord[];
  expiringEgnpi: number;
}

export interface FqSlice {
  expLayers: QuoteLayerDraft[];
  numExpLayers: number;
  clientStructures: QuoteStructureDraft[];
  /** Legacy persisted quote structures (read-only passthrough). */
  quoteStructures: LooseRecord[];
  approvedStructures: boolean[];
  quotePricing: LooseRecord;
  /** {scope: {cobId: raw-digit string}} */
  quoteCobUwLimits: Record<string, Record<string, string>>;
  /** {scope: {cobId: bool[] per layer}} */
  cobToggles: Record<string, Record<string, boolean[]>>;
  cobManual: Record<string, Record<string, boolean[]>>;
  selectedCobs: SelectedCob[];
  cobList: Array<{ id: string | number; name: string; [extra: string]: unknown }>;
}

export interface WorkflowSlice {
  offerStatus: string;
  offerApprover: string;
  offerComment: string;
  returnReason: string;
  declineReason: string;
  /** Per-layer written line % keyed by layer index. */
  layerWrittenLines: Record<string, NumericLike>;
  signedLinePcts: Record<string, NumericLike>;
  approvalTrail: LooseRecord[];
  eligibleApprovers: LooseRecord[];
}

export interface BenchmarkModalState {
  open: boolean;
  scope: string;
  sourceLabel: string;
  sourceLayers: LooseRecord[];
}
export interface PricingGraphModalState {
  open: boolean;
  sourceLabel: string;
  structure: QuoteStructureDraft | null;
}
export interface PricingAnalysisModalState {
  open: boolean;
  structureIndex: number | null;
}

export interface ModalsSlice {
  showDeclineModal: boolean;
  showOfferModal: boolean;
  showReinsurerModal: boolean;
  showTechAnalysisModal: boolean;
  showCobModal: boolean;
  marketModalOpen: boolean;
  insightOpen: boolean;
  insightKey: string;
  benchmarkModal: BenchmarkModalState;
  pricingGraphModal: PricingGraphModalState;
  pricingAnalysisModal: PricingAnalysisModalState;
}

export interface SaveLifecycleSlice {
  saveState: { status: 'idle' | 'saving' | 'saved' | 'error'; at: number | null; error: string | null };
  /** Optimistic-lock token from the last load/save response. */
  lastUpdatedAt: string | null;
}

export interface UiSlice {
  loading: boolean;
  calcEngineRunning: boolean;
  calcEngineError: string;
  /** {structureIndex: true} — per-structure quote calc in flight. */
  runningStructures: Record<number, boolean>;
  progLimView: 'limits' | 'optimal';
}

export interface RefDataSlice {
  reinsurers: LooseRecord[];
  portfolioTreaties: LooseRecord[];
  portfolioExportRows: LooseRecord[];
  cedantProgLimit: number;
  contractAgg100: number;
  otherCountryAgg: number;
}

export interface NpPricingState {
  layers: LayersSlice;
  fq: FqSlice;
  workflow: WorkflowSlice;
  modals: ModalsSlice;
  saveLifecycle: SaveLifecycleSlice;
  ui: UiSlice;
  refData: RefDataSlice;
}

export function createInitialPricingState(): NpPricingState {
  return {
    layers: {
      layers: [],
      leadSetup: [],
      localStructureLayers: [],
      treatyMetrics: {},
      cobUwLimits: [],
      expiringEgnpi: 0,
    },
    fq: {
      expLayers: Array.from({ length: 3 }, (_, i) => emptyExpLayer(i)),
      numExpLayers: 3,
      clientStructures: [],
      quoteStructures: [],
      approvedStructures: [],
      quotePricing: {},
      quoteCobUwLimits: {},
      cobToggles: {},
      cobManual: {},
      selectedCobs: [],
      cobList: [],
    },
    workflow: {
      offerStatus: '',
      offerApprover: '',
      offerComment: '',
      returnReason: '',
      declineReason: '',
      layerWrittenLines: {},
      signedLinePcts: {},
      approvalTrail: [],
      eligibleApprovers: [],
    },
    modals: {
      showDeclineModal: false,
      showOfferModal: false,
      showReinsurerModal: false,
      showTechAnalysisModal: false,
      showCobModal: false,
      marketModalOpen: false,
      insightOpen: false,
      insightKey: '',
      benchmarkModal: { open: false, scope: 'country', sourceLabel: '', sourceLayers: [] },
      pricingGraphModal: { open: false, sourceLabel: '', structure: null },
      pricingAnalysisModal: { open: false, structureIndex: null },
    },
    saveLifecycle: {
      saveState: { status: 'idle', at: null, error: null },
      lastUpdatedAt: null,
    },
    ui: {
      loading: false,
      calcEngineRunning: false,
      calcEngineError: '',
      runningStructures: {},
      progLimView: 'limits',
    },
    refData: {
      reinsurers: [],
      portfolioTreaties: [],
      portfolioExportRows: [],
      cedantProgLimit: 0,
      contractAgg100: 0,
      otherCountryAgg: 0,
    },
  };
}

/** useState-compatible setter argument: a value or a functional updater. */
export type Setter<T> = T | ((prev: T) => T);

type SliceSetAction<N extends string, S> = {
  [K in keyof S & string]: { type: `${N}/set`; key: K; next: Setter<S[K]> };
}[keyof S & string];

/** Pricing-engine per-layer result (see utils/npPricingEngine.js). */
export interface EngineComponentResult {
  pureBurn?: NumericLike;
  pareto?: NumericLike;
  exposureRating?: NumericLike;
  prAttach?: NumericLike;
  prExhaust?: NumericLike;
  [extra: string]: unknown;
}
export interface EngineLayerResult {
  idx: number;
  risk?: EngineComponentResult | null;
  cat?: EngineComponentResult | null;
  [extra: string]: unknown;
}

export type PricingAction =
  | SliceSetAction<'layers', LayersSlice>
  | SliceSetAction<'fq', FqSlice>
  | SliceSetAction<'workflow', WorkflowSlice>
  | SliceSetAction<'modals', ModalsSlice>
  | SliceSetAction<'ui', UiSlice>
  | SliceSetAction<'refData', RefDataSlice>
  // ── save lifecycle ──
  | { type: 'save/start' }
  | { type: 'save/saved'; at: number }
  | { type: 'save/failed'; at: number; error: string }
  | { type: 'save/lock'; lastUpdatedAt: string | null }
  // ── calc-engine lifecycle (global run or per-structure quote run) ──
  | { type: 'engine/start'; structureIndex: number | null }
  | { type: 'engine/finish'; structureIndex: number | null }
  | { type: 'engine/error'; message: string }
  // ── treaty-mode layer edits + derived recomputes ──
  | { type: 'layers/edit'; index: number; field: string; value: unknown; brokeragePct: unknown; taxesPct: unknown }
  | { type: 'layers/editLeadSetup'; index: number; field: string; value: unknown }
  | {
      type: 'layers/applyAutoColumns';
      snap: { reinsurer: string[]; lead: string[] };
      expKnown: Array<[number, number]> | null;
      brokeragePct: unknown;
      taxesPct: unknown;
    }
  | {
      type: 'layers/applyHistoricalMargins';
      largeByYear: Map<string, number[]>;
      catByYear: Map<string, number[]>;
      bothByYear: Map<string, number[]>;
      brokeragePct: unknown;
      taxesPct: unknown;
    }
  | { type: 'layers/recomputeTechRatios'; brokeragePct: unknown; taxesPct: unknown }
  | { type: 'layers/applyEngineResults'; results: EngineLayerResult[] }
  // ── quote-mode (FQ) edits ──
  | { type: 'fq/editExpLayer'; index: number; field: string; value: unknown }
  | { type: 'fq/setNumExpLayers'; n: number }
  | { type: 'fq/editStructureLayer'; structureIndex: number; layerIndex: number; field: string; value: unknown; curve: unknown }
  | { type: 'fq/addStructure'; idBase: number; defaults: PerilDefaults }
  | { type: 'fq/addStructureLayer'; structureIndex: number; defaults: PerilDefaults }
  | { type: 'fq/removeStructureLayer'; structureIndex: number; layerIndex: number }
  | { type: 'fq/removeStructure'; index: number }
  | { type: 'fq/setApprovedStructure'; index: number; checked: boolean }
  | { type: 'fq/setCobToggle'; scope: string; cobId: string | number; layerIndex: number; currentFlag: boolean }
  | { type: 'fq/setCobUwLimit'; scope: string; cobId: string | number; value: string }
  | { type: 'fq/applyQuoteEngineResults'; byKey: Map<string, EngineLayerResult> }
  // ── modal open/close pairs that carry payloads ──
  | { type: 'modals/openBenchmark'; scope: string; sourceLabel: string; sourceLayers: LooseRecord[] }
  | { type: 'modals/closeBenchmark' }
  | { type: 'modals/openPricingGraph'; sourceLabel: string; structure: QuoteStructureDraft }
  | { type: 'modals/closePricingGraph' }
  | { type: 'modals/openPricingAnalysis'; structureIndex: number }
  | { type: 'modals/closePricingAnalysis' }
  // ── contract switch: reset local state exactly like the legacy effect ──
  | { type: 'contract/reset' };
