// state/structureReducer.ts — typed state container for the NP Structure
// screen (Phase 4.2 decomposition of NpStructure.jsx).
//
// Every transition here was moved VERBATIM from the pre-refactor screen's
// useState updaters — this file owns the NP layer-structure math (layer
// deductible cascade, earned premium / ROL / MDP% recalc, expiring
// structure recalc, COB auto-coverage). Behaviour is pinned by
// goldenMaster.test.jsx: do not "fix" rounding/format here without
// updating that contract deliberately.
//
// Formatted values stay STRINGS end to end (see the NumericLike notes in
// client/src/types/pricing.ts) — the reducer never converts a money field
// to a number except inside the pure recalc helpers.

import {
  toNum, rateToFloat, appendPct, fmtPctMaybe,
  parseExcelInt, emptyLayer, emptyCoveredProp,
  PASTE_FIELD_ORDER, NUMERIC_FIELDS,
} from '../NpStructureHelpers';

/* ── Row shapes ──
   Layer rows hydrate from either the relational tables (fully shaped) or
   the JSONB terms blob (spread over emptyLayer, so extra keys can ride
   along and cover booleans may be absent) — hence the optional booleans
   and the open index signature. */
export interface LayerRow {
  layer: number | string;
  limit: string;
  deductible: string;
  annualAggLimit: string;
  egnpi: string;
  rate: string;
  earnedPremium: string;
  mdp: string;
  mdpPct: string;
  reinstatements: string;
  reinstatementPct: string;
  aad?: boolean;
  aadAmount: string;
  riskCover?: boolean;
  catCover?: boolean;
  rol: string;
  classOfBusinessIds?: string[];
  [extra: string]: unknown;
}

export interface ExpiringLayerRow {
  layer: number | string;
  limit: string;
  deductible: string;
  annualAggLimit?: string;
  egnpi: string;
  rate: string;
  earnedPremium: string;
  rol: string;
  mdp: string;
  mdpPct: string;
  reinstatements?: string;
  reinstatementPct?: string;
  aad?: boolean;
  aadAmount?: string;
  riskCover?: boolean;
  catCover?: boolean;
  perilScope?: string;
  [extra: string]: unknown;
}

/** COB participation row. JSONB-hydrated rows (quote mode) may be sparse. */
export interface CobRow {
  cobId: string;
  name?: string;
  code?: string;
  underwritingLimit?: string;
  layers?: boolean[];
  manual?: boolean[];
  [extra: string]: unknown;
}

export interface CobOption {
  id: string;
  name: string;
  code?: string;
  [extra: string]: unknown;
}

/** Net XL covered proportional programme row (server rows may be sparse). */
export interface CoveredPropRow {
  cobId?: string;
  qsLimit?: string;
  retentionPct?: string;
  surplusLines?: string;
  [extra: string]: unknown;
}

export type ExpiringTermKey =
  | 'egnpi' | 'deductible' | 'risk_limit' | 'cat_limit'
  | 'brokerage_pct' | 'no_claims_bonus_pct' | 'profit_commission_pct' | 'notes';

export type ExpiringTerms = Partial<Record<ExpiringTermKey, string>>;

export type TreatyMode = 'RISK' | 'CAT' | 'BOTH';

/* ════════════════════ Pure layer-structure math ════════════════════ */

/* ── Recalculate deductibles (cascade from layer 1) ──
   Each layer's deductible = previous layer's deductible + previous layer's limit.
   Must accumulate — read from the updated result, not the original array.
── */
export function recomputeDeductibles(allLayers: LayerRow[], baseDeductible: string): LayerRow[] {
  if (!allLayers.length) return allLayers;
  // A base of '', '0' or garbage means "no treaty-detail deductible available"
  // (e.g. the detail slice was never hydrated this session) — layer 1 must then
  // KEEP its loaded value. '0' is a truthy string, so a plain `base ||` fallback
  // would overwrite a real saved attachment with 0 and the next save would
  // persist the loss.
  const base = toNum(baseDeductible) > 0 ? String(toNum(baseDeductible)) : '';
  const result: LayerRow[] = [];
  for (let i = 0; i < allLayers.length; i++) {
    if (i === 0) {
      result.push({ ...allLayers[0], deductible: base || allLayers[0].deductible });
    } else {
      const prev = result[i - 1];                    // use updated previous, not original
      const prevDed = toNum(prev.deductible);
      const prevLim = toNum(prev.limit);
      const nextDed = prevDed + prevLim;
      result.push({ ...allLayers[i], deductible: nextDed > 0 ? String(nextDed) : allLayers[i].deductible });
    }
  }
  return result;
}

/* ── Recalculate financials ──
   Earned Premium = EGNPI × Rate%   e.g. 120,000,000 × 3% = 3,600,000
   rateToFloat("3%") = 3  →  multiply by 3 then divide by 100
── */
export function recomputeFinancials(l: LayerRow): LayerRow {
  const egnpi   = toNum(l.egnpi);
  const ratePct = rateToFloat(l.rate);          // "3%" → 3
  const earned  = (egnpi > 0 && ratePct > 0)
    ? Math.round(egnpi * ratePct / 100)         // 120,000,000 × 3 / 100 = 3,600,000
    : 0;
  const limit  = toNum(l.limit);
  const rol    = (limit > 0 && earned > 0) ? fmtPctMaybe(earned / limit) : '';
  const mdp    = toNum(l.mdp);
  const mdpPct = (earned > 0 && mdp > 0) ? fmtPctMaybe(mdp / earned) : '';
  return { ...l, earnedPremium: earned ? String(earned) : '', rol, mdpPct };
}

/* ── Full recalc pipeline — used when user edits limit/deductible (cascades deductibles) ── */
export function fullRecalc(allLayers: LayerRow[], baseDeductible: string): LayerRow[] {
  const withDed = recomputeDeductibles(allLayers, baseDeductible);
  return withDed.map(l => recomputeFinancials(l));
}

/* ── Financials-only recalc — used on load (deductibles already correct from DB, don't overwrite) ── */
export function recalcFinancialsOnly(allLayers: LayerRow[]): LayerRow[] {
  return allLayers.map(l => recomputeFinancials(l));
}

/* ── Expiring layer recalc: cascade deductibles + compute earned/mdpPct/rol ──
   skipDedCascade=true on load (deductibles already correct from DB)
   skipDedCascade=false on user edit (cascade from layer 1 downward)          ── */
export function expiringRecalc(allLayers: ExpiringLayerRow[], skipDedCascade = false): ExpiringLayerRow[] {
  const result: ExpiringLayerRow[] = [];
  for (let i = 0; i < allLayers.length; i++) {
    const l = { ...allLayers[i] };
    // Deductible cascade — skip on load, run on user edit
    if (!skipDedCascade && i > 0) {
      const prev = result[i - 1];
      const prevDed = toNum(prev.deductible);
      const prevLim = toNum(prev.limit);
      if (prevDed + prevLim > 0) l.deductible = String(prevDed + prevLim);
    }
    // Earned Premium = EGNPI × Rate%  — only overwrite if we can compute it
    const egnpiN  = toNum(l.egnpi);
    const ratePct = rateToFloat(l.rate);
    const computed = (egnpiN > 0 && ratePct > 0) ? Math.round(egnpiN * ratePct / 100) : 0;
    if (computed > 0) l.earnedPremium = String(computed);
    // else: keep whatever DB value was hydrated (strOrEmpty already applied)
    const earnedN = computed || toNum(l.earnedPremium);
    // ROL = Earned Premium / Limit
    const limitN = toNum(l.limit);
    l.rol = (limitN > 0 && earnedN > 0) ? fmtPctMaybe(earnedN / limitN) : (l.rol || '');
    // MDP% = MDP / Earned Premium
    const mdpN = toNum(l.mdp);
    l.mdpPct = (earnedN > 0 && mdpN > 0) ? fmtPctMaybe(mdpN / earnedN) : '';
    result.push(l);
  }
  return result;
}

/* ── Lock risk/cat covers based on treaty type ── */
export function applyTreatyModeCovers(allLayers: LayerRow[], mode: TreatyMode): LayerRow[] {
  return allLayers.map(l => {
    if (mode === 'RISK') return { ...l, riskCover: true, catCover: false };
    if (mode === 'CAT')  return { ...l, riskCover: false, catCover: true };
    // BOTH or other (Stop Loss, Aggregate XL, etc.) — default both on, user can deselect
    return { ...l, riskCover: l.riskCover !== undefined ? l.riskCover : true, catCover: l.catCover !== undefined ? l.catCover : true };
  });
}

/* ── Auto-recompute COB coverage from underwriting limits ──
   Business rule: a COB participates in a layer if and only if
   its underwriting limit EXCEEDS that layer's attachment (deductible).
   i.e. UW limit > attachment → loss from this COB can trigger that layer.
   Manual overrides (r.manual[i] = true) bypass the auto-calc for that cell.
── */
export function recomputeCobCoverage(rows: CobRow[], layerData: LayerRow[]): CobRow[] {
  return rows.map(r => {
    const ul = toNum(r.underwritingLimit);
    const n = layerData.length;
    const nextLayers = [...(r.layers || [])];
    const manual = [...(r.manual || [])];
    while (nextLayers.length < n) nextLayers.push(false);
    while (manual.length < n) manual.push(false);
    for (let i = 0; i < n; i++) {
      if (manual[i]) continue;
      const attach = toNum(layerData[i]?.deductible);
      // COB triggers this layer only if its UW limit exceeds the layer attachment
      nextLayers[i] = ul > attach;
    }
    return { ...r, layers: nextLayers, manual };
  });
}

/* ── Excel paste: apply a clipboard matrix onto rows (mutates `next`) ──
   Shared by the layer and expiring tables; the loop is byte-identical to
   both pre-refactor handlers. Single-column pastes hit the target field;
   multi-column pastes spread across PASTE_FIELD_ORDER from the start field. */
function applyPasteMatrix(
  next: Array<Record<string, unknown>>,
  matrix: string[][],
  startRow: number,
  field: string,
): void {
  const startCol = Math.max(0, PASTE_FIELD_ORDER.indexOf(field));
  for (let r = 0; r < matrix.length; r++) {
    const idx = startRow + r;
    if (idx >= next.length) break;
    const rowVals = matrix[r] || [];
    if (rowVals.length <= 1) {
      // Single column paste into the target field
      const val = rowVals[0] || '';
      if (NUMERIC_FIELDS.has(field)) next[idx][field] = parseExcelInt(val);
      else if (field === 'rate') next[idx].rate = appendPct(val);
      else next[idx][field] = val;
    } else {
      for (let c = 0; c < rowVals.length; c++) {
        const f = PASTE_FIELD_ORDER[startCol + c];
        if (!f) break;
        const val = rowVals[c] || '';
        if (NUMERIC_FIELDS.has(f)) next[idx][f] = parseExcelInt(val);
        else if (f === 'rate') next[idx].rate = appendPct(val);
        else next[idx][f] = val;
      }
    }
  }
}

/* Blank expiring rows. Two shapes existed pre-refactor and both are kept:
   the edit path's blank row carries perilScope, the paste path's does not. */
const expiringEmptyEditRow = (): ExpiringLayerRow => ({
  layer: 0, limit: '', deductible: '', annualAggLimit: '', egnpi: '', earnedPremium: '',
  rate: '', mdp: '', mdpPct: '', reinstatements: '', reinstatementPct: '',
  aad: false, aadAmount: '', riskCover: true, catCover: true, rol: '', perilScope: 'BOTH',
});
const expiringEmptyPasteRow = (): ExpiringLayerRow => ({
  layer: 0, limit: '', deductible: '', annualAggLimit: '', egnpi: '', earnedPremium: '',
  rate: '', mdp: '', mdpPct: '', reinstatements: '', reinstatementPct: '',
  aad: false, aadAmount: '', riskCover: true, catCover: true, rol: '',
});

/* ════════════════════ State + actions ════════════════════ */

export interface StructureState {
  layers: LayerRow[];
  cobRows: CobRow[];
  coveredProps: CoveredPropRow[];
  cobOptions: CobOption[];
  savedQuoteStructures: unknown[];
  loading: boolean;
  expiringLayerCount: number;
  expiringLayers: ExpiringLayerRow[];
  expiringTerms: ExpiringTerms;
  isRenewal: boolean;
  expiringAutoPopulated: boolean;
  expiringCoveredProps: CoveredPropRow[];
  lastUpdatedAt: string | null;
  showExpCurveModal: boolean;
}

export const initialStructureState: StructureState = {
  layers: [],
  cobRows: [],
  coveredProps: [],
  cobOptions: [],
  savedQuoteStructures: [],
  loading: false,
  expiringLayerCount: 0,
  expiringLayers: [],
  expiringTerms: {},
  isRenewal: false,
  expiringAutoPopulated: false,
  expiringCoveredProps: [emptyCoveredProp()],
  lastUpdatedAt: null,
  showExpCurveModal: false,
};

export type StructureAction =
  /* load lifecycle */
  | { type: 'load/started' }
  | {
      type: 'load/structureLoaded';
      layers: LayerRow[];
      /** null = leave existing rows untouched (no relational/JSONB data). */
      cobRows: CobRow[] | null;
      /** null = leave untouched (no saved quote structures). */
      savedQuoteStructures: unknown[] | null;
      coveredProps: CoveredPropRow[];
      lastUpdatedAt: string | null;
    }
  | { type: 'load/structureFailed'; layers: LayerRow[]; coveredProps: CoveredPropRow[] }
  | { type: 'load/finished' }
  | {
      type: 'load/expiringLoaded';
      isRenewal: boolean;
      autoPopulated: boolean;
      layerCount: number;
      layers: ExpiringLayerRow[];
      /** null = server sent no terms; keep current. */
      terms: ExpiringTerms | null;
      coveredProps: CoveredPropRow[];
    }
  /* layer edits */
  | { type: 'layer/fieldEdited'; idx: number; field: string; value: string | boolean; baseDeductible: string }
  | { type: 'layer/pasted'; startRow: number; field: string; matrix: string[][]; baseDeductible: string }
  /* layer count changes */
  | { type: 'layer/added'; baseDeductible: string }
  | { type: 'layer/lastDeleted'; baseDeductible: string }
  | { type: 'layers/resyncedFromDetail'; numLayersChanged: boolean; count: number; baseDeductible: string }
  /* COB participation */
  | { type: 'cob/optionsLoaded'; options: CobOption[] }
  | { type: 'cob/rowsEnsured' }
  | { type: 'cob/fieldEdited'; idx: number; field: string; value: string }
  | { type: 'cob/layerToggled'; cobIdx: number; layerIdx: number }
  /* covered props */
  | { type: 'coveredProp/edited'; idx: number; field: string; value: string }
  /* expiring edits */
  | { type: 'expiring/layerEdited'; idx: number; field: string; value: string | boolean }
  | { type: 'expiring/pasted'; startRow: number; field: string; matrix: string[][] }
  | { type: 'expiring/termEdited'; key: ExpiringTermKey; value: string }
  | { type: 'expiring/countSynced'; count: number }
  | { type: 'expiring/overrideEnabled' }
  | { type: 'expiring/coveredPropEdited'; idx: number; field: string; value: string }
  | { type: 'expiring/coveredPropAdded' }
  | { type: 'expiring/coveredPropRemoved' }
  /* save lifecycle */
  | { type: 'save/recorded'; updatedAt: string }
  /* modal toggles */
  | { type: 'modal/expCurveSet'; open: boolean };

/* eslint-disable-next-line complexity -- exhaustive action switch */
export function structureReducer(state: StructureState, action: StructureAction): StructureState {
  switch (action.type) {
    /* ── load lifecycle ── */
    case 'load/started':
      return { ...state, loading: true };
    case 'load/finished':
      return { ...state, loading: false };
    case 'load/structureLoaded':
      return {
        ...state,
        lastUpdatedAt: action.lastUpdatedAt,
        layers: action.layers,
        cobRows: action.cobRows !== null ? action.cobRows : state.cobRows,
        savedQuoteStructures:
          action.savedQuoteStructures !== null ? action.savedQuoteStructures : state.savedQuoteStructures,
        coveredProps: action.coveredProps,
      };
    case 'load/structureFailed':
      return { ...state, layers: action.layers, coveredProps: action.coveredProps };
    case 'load/expiringLoaded':
      return {
        ...state,
        isRenewal: action.isRenewal,
        expiringAutoPopulated: action.autoPopulated,
        expiringLayerCount: action.layerCount,
        expiringLayers: action.layers,
        expiringTerms: action.terms !== null ? action.terms : state.expiringTerms,
        expiringCoveredProps: action.coveredProps,
      };

    /* ── layer edits ── */
    case 'layer/fieldEdited': {
      const next = [...state.layers];
      next[action.idx] = { ...next[action.idx], [action.field]: action.value };
      const recalced = fullRecalc(next, action.baseDeductible);
      return {
        ...state,
        layers: recalced,
        cobRows: action.field === 'limit' ? recomputeCobCoverage(state.cobRows, recalced) : state.cobRows,
      };
    }
    case 'layer/pasted': {
      const next = state.layers.map(l => ({ ...l }));
      applyPasteMatrix(next, action.matrix, action.startRow, action.field);
      return { ...state, layers: fullRecalc(next, action.baseDeductible) };
    }

    /* ── layer count changes ── */
    case 'layer/added': {
      const recalced = fullRecalc(
        [...state.layers, emptyLayer(state.layers.length) as LayerRow],
        action.baseDeductible,
      );
      return { ...state, layers: recalced, cobRows: recomputeCobCoverage(state.cobRows, recalced) };
    }
    case 'layer/lastDeleted': {
      if (state.layers.length <= 1) return state;
      const recalced = fullRecalc(state.layers.slice(0, -1), action.baseDeductible);
      return { ...state, layers: recalced, cobRows: recomputeCobCoverage(state.cobRows, recalced) };
    }
    case 'layers/resyncedFromDetail': {
      let ls = [...state.layers];
      // Adjust layer count if numberOfLayers changed
      if (action.numLayersChanged && action.count > 0) {
        while (ls.length < action.count) ls.push(emptyLayer(ls.length) as LayerRow);
        if (ls.length > action.count) ls = ls.slice(0, action.count);
      }
      // Re-cascade deductibles from base deductible (fullRecalc does recomputeDeductibles + financials)
      return { ...state, layers: fullRecalc(ls, action.baseDeductible) };
    }

    /* ── COB participation ── */
    case 'cob/optionsLoaded':
      return { ...state, cobOptions: action.options };
    case 'cob/rowsEnsured': {
      // Two jobs (mirrors the pre-refactor cobOptions sync effect):
      // 1. If cobRows is empty (first visit, no saved data), initialise from cobOptions.
      // 2. Backfill any cobRow whose name is missing/empty once cobOptions loads.
      if (!state.cobOptions.length || !state.layers.length) return state;
      if (state.cobRows.length === 0) {
        const n = state.layers.length;
        return {
          ...state,
          cobRows: state.cobOptions.map(c => ({
            cobId: String(c.id), name: c.name, code: c.code || '',
            underwritingLimit: '', layers: Array(n).fill(false), manual: Array(n).fill(false),
          })),
        };
      }
      const optMap = new Map(state.cobOptions.map(c => [String(c.id), c]));
      const needsFill = state.cobRows.some(r => !r.name || r.name === r.cobId);
      if (!needsFill) return state;
      return {
        ...state,
        cobRows: state.cobRows.map(r => {
          if (r.name && r.name !== r.cobId) return r;
          const opt = optMap.get(String(r.cobId));
          return opt ? { ...r, name: opt.name, code: opt.code || r.code || '' } : r;
        }),
      };
    }
    case 'cob/fieldEdited': {
      const next = [...state.cobRows];
      next[action.idx] = { ...next[action.idx], [action.field]: action.value };
      if (action.field === 'underwritingLimit') {
        return { ...state, cobRows: recomputeCobCoverage(next, state.layers) };
      }
      return { ...state, cobRows: next };
    }
    case 'cob/layerToggled': {
      const next = [...state.cobRows];
      const r = { ...next[action.cobIdx] };
      r.layers = [...(r.layers || [])];
      r.manual = [...(r.manual || [])];
      r.layers[action.layerIdx] = !r.layers[action.layerIdx];
      r.manual[action.layerIdx] = true;
      next[action.cobIdx] = r;
      return { ...state, cobRows: next };
    }

    /* ── covered props ── */
    case 'coveredProp/edited': {
      const next = [...state.coveredProps];
      next[action.idx] = { ...next[action.idx], [action.field]: action.value };
      return { ...state, coveredProps: next };
    }

    /* ── expiring edits ── */
    case 'expiring/layerEdited': {
      const next = [...state.expiringLayers];
      while (next.length <= action.idx) next.push({ ...expiringEmptyEditRow(), layer: next.length + 1 });
      next[action.idx] = { ...next[action.idx], [action.field]: action.value };
      // Cascade deductibles + recompute earned/rol/mdpPct
      return { ...state, expiringLayers: expiringRecalc(next) };
    }
    case 'expiring/pasted': {
      // Ensure array is long enough
      const next = Array.from(
        { length: Math.max(state.expiringLayerCount, state.expiringLayers.length) },
        (_, i) => {
          const existing = state.expiringLayers[i] as ExpiringLayerRow | undefined;
          return { ...expiringEmptyPasteRow(), layer: i + 1, ...(existing || {}) };
        },
      );
      applyPasteMatrix(next, action.matrix, action.startRow, action.field);
      return { ...state, expiringLayers: expiringRecalc(next) }; // cascade deductibles + recompute financials
    }
    case 'expiring/termEdited':
      return { ...state, expiringTerms: { ...state.expiringTerms, [action.key]: action.value } };
    case 'expiring/countSynced':
      return { ...state, expiringLayerCount: action.count };
    case 'expiring/overrideEnabled':
      return { ...state, expiringAutoPopulated: false };
    case 'expiring/coveredPropEdited': {
      const next = [...state.expiringCoveredProps];
      next[action.idx] = { ...next[action.idx], [action.field]: action.value };
      return { ...state, expiringCoveredProps: next };
    }
    case 'expiring/coveredPropAdded':
      return { ...state, expiringCoveredProps: [...state.expiringCoveredProps, emptyCoveredProp()] };
    case 'expiring/coveredPropRemoved':
      return { ...state, expiringCoveredProps: state.expiringCoveredProps.slice(0, -1) };

    /* ── save lifecycle ── */
    case 'save/recorded':
      return { ...state, lastUpdatedAt: action.updatedAt };

    /* ── modal toggles ── */
    case 'modal/expCurveSet':
      return { ...state, showExpCurveModal: action.open };

    default:
      return state;
  }
}

export default structureReducer;
