// state/structureHydration.ts — pure server-response → screen-state mappers
// for the NP Structure screen. Extracted VERBATIM from the pre-refactor
// load effect in NpStructure.jsx; the hook (useNpStructureState) calls
// these inside the same .then() handlers so hydration ordering is
// unchanged. Behaviour pinned by goldenMaster.test.jsx.

import type { NpExpiringBundle, QuoteStructure } from '../../../../types/pricing';
import { emptyLayer, emptyCoveredProp, strOrEmpty, strRate, toNum } from '../NpStructureHelpers';
import {
  applyTreatyModeCovers,
  recalcFinancialsOnly,
  expiringRecalc,
} from './structureReducer';
import type {
  CobRow,
  CoveredPropRow,
  ExpiringLayerRow,
  ExpiringTerms,
  LayerRow,
  TreatyMode,
} from './structureReducer';

export interface StructureHydration {
  lastUpdatedAt: string | null;
  layers: LayerRow[];
  /** null = no relational/JSONB COB data — leave current rows untouched. */
  cobRows: CobRow[] | null;
  /** null = no saved quote structures — leave current value untouched. */
  savedQuoteStructures: unknown[] | null;
  coveredProps: CoveredPropRow[];
  /** Stop Loss / Aggregate XL JSONB slice backups (null = absent). */
  stopLossSlice: Record<string, unknown> | null;
  aggregateXlSlice: Record<string, unknown> | null;
  stopLossExpiringSlice: Record<string, unknown> | null;
}

const asSlice = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object') ? (v as Record<string, unknown>) : null;

/* ── Hydrate the main structure response ──
   Source of truth priority:
     1. contract_np_layers (relational) — always the authoritative layer data
     2. contract_np_layer_class_of_business (junction) — which COBs participate per layer
     3. contract_underwriting_limit (relational) — UW limit per COB
     4. np_structure JSONB — fallback for quote structures + coveredProps only
── */
export function hydrateStructureResponse(
  data: QuoteStructure | null | undefined,
  ctx: { quoteMode: boolean; mode: TreatyMode; numLayersFallback: number },
): StructureHydration {
  const terms = (data?.terms || {}) as Record<string, any>;
  const saved = (terms?.np_structure || terms?.structure || {}) as Record<string, any>;
  const relationalLayers = data?.layers || [];
  const cobUwLimits = data?.cob_underwriting_limits || []; // [{cob_id, limit_amount}]

  // ── Build layers from relational table (authoritative) ──
  let ls: LayerRow[];
  if (relationalLayers.length > 0) {
    ls = relationalLayers.map((rl, i) => ({
      ...(emptyLayer(i) as LayerRow),
      layer: rl.layer_number || (i + 1),
      limit: strOrEmpty(rl.layer_limit),
      deductible: strOrEmpty(rl.attachment),
      annualAggLimit: strOrEmpty(rl.aggregate_limit),
      egnpi: strOrEmpty(rl.egnpi),
      rate: strRate(rl.rate),           // plain number from DB → bare string for RateInput
      earnedPremium: '',                // always recomputed by fullRecalc
      rol: '',                          // always recomputed by fullRecalc
      reinstatements: strOrEmpty(rl.num_reinstatements),
      reinstatementPct: strOrEmpty(rl.reinstatement_pct),
      aad: !!rl.annual_agg_deductible,
      aadAmount: strOrEmpty(rl.annual_agg_deductible),
      riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
      catCover: rl.peril_scope === 'CAT' || rl.peril_scope === 'BOTH',
      mdp: strOrEmpty(rl.mdp),
      mdpPct: '',                       // always recomputed by fullRecalc
      // classOfBusinessIds from the junction table (already loaded by server)
      classOfBusinessIds: Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [],
    }));
  } else {
    // No relational layers yet — use JSONB fallback or build from treaty detail layer count.
    // Priority: data.detail.number_of_layers (just fetched) → AppContext → default 4
    const jsonbLayers: any[] = saved.layers || [];
    const countFromDetail = parseInt(String(data?.detail?.number_of_layers || '0'), 10) || 0;
    const count = countFromDetail > 0 ? countFromDetail : ctx.numLayersFallback;
    const baseDeductible = String(toNum(data?.detail?.deductible || data?.detail?.max_retention || 0) || 0);
    ls = jsonbLayers.map((l, i) => ({ ...(emptyLayer(i) as LayerRow), ...l }));
    while (ls.length < count) ls.push(emptyLayer(ls.length) as LayerRow);
    // Trim to count if JSONB had more rows than current layer count
    if (ls.length > count && count > 0) ls = ls.slice(0, count);
    // Seed layer 1 deductible from detail if not already set
    if (ls.length > 0 && !ls[0].deductible && baseDeductible !== '0') {
      ls[0] = { ...ls[0], deductible: baseDeductible };
    }
  }
  ls = applyTreatyModeCovers(ls, ctx.mode);
  ls = recalcFinancialsOnly(ls); // load: deductibles already from DB, only recompute earned/rol/mdpPct

  // ── Build cobRows ──
  // For standard mode: reconstruct from relational data (UW limits + junction table COB ids per layer).
  // For quote mode:  reconstruct from JSONB cobRows (no junction table for quotes).
  // Fallback in both cases: JSONB cobRows if relational data missing.
  const jsonbCobRows: any[] = saved.cobRows || saved.cob_rows || [];

  let cobRows: CobRow[] | null = null;
  if (!ctx.quoteMode && cobUwLimits.length > 0) {
    // Standard mode — relational source of truth
    // Build a name map from JSONB backup (populated on previous saves)
    const nameMap = new Map(jsonbCobRows.map(r => [String(r.cobId), { name: r.name, code: r.code || '' }]));
    const manualMap = new Map(jsonbCobRows.map(r => [String(r.cobId), r.manual || []]));

    cobRows = cobUwLimits.map(r => {
      const cobId = String(r.cob_id);
      const meta = nameMap.get(cobId) || {};
      // Layer participation: which layers have this COB in their classOfBusinessIds?
      const layerFlags = ls.map(l => (l.classOfBusinessIds || []).includes(cobId));
      const savedManual: boolean[] = manualMap.get(cobId) || [];
      return {
        cobId,
        name: (meta as { name?: string }).name || '', // backfilled from cobOptions once that loads
        code: (meta as { code?: string }).code || '',
        underwritingLimit: String(r.limit_amount ?? ''),
        layers: layerFlags,
        manual: Array(ls.length).fill(false).map((_, i) => savedManual[i] || false),
      };
    });
  } else if (jsonbCobRows.length > 0) {
    // Quote mode or no relational data yet — use JSONB cobRows directly
    // For quote mode these are the structure 0 cobRows saved in JSONB terms
    cobRows = jsonbCobRows;
  }
  // else: leave null — cobOptions sync effect will initialise from cobOptions

  // Quote structures (for quote mode) — still JSONB-based
  const savedQuoteStructures =
    Array.isArray(saved.structures) && saved.structures.length ? (saved.structures as unknown[]) : null;

  // Covered props
  const cp: CoveredPropRow[] = saved.coveredProps || saved.covered_props || [];

  // Round-trip Stop Loss / Aggregate XL slices from the JSONB backup written
  // by save(). The Structure screen renders NpStopLossStructure /
  // NpStopLossExpiring / NpAggregateXlStructure but those components only
  // write to AppContext slices — their canonical save endpoint
  // (saveNpStopLossPricing) lives on the Pricing screen, and Aggregate XL
  // has no rescue path at all. Without this hydrate, a refresh on Structure
  // loses Aggregate XL entirely, and loses Stop Loss unless the user
  // reached Pricing first. The hook merges these under in-flight slice
  // edits (mergeWithCurrent) exactly like NpStopLossPricing.onLoaded.
  return {
    lastUpdatedAt: data?.updated_at || null,
    layers: ls,
    cobRows,
    savedQuoteStructures,
    coveredProps: cp.length > 0 ? cp : [emptyCoveredProp()],
    stopLossSlice: asSlice(saved.stop_loss),
    aggregateXlSlice: asSlice(saved.aggregate_xl),
    stopLossExpiringSlice: asSlice(saved.stop_loss_expiring),
  };
}

/* Merge a server-loaded slice under in-flight edits — non-empty existing
   fields win, server fills the rest. Mirrors NpStopLossPricing.onLoaded. */
export function mergeWithCurrent(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(incoming || {}) };
  const cur = current || {};
  for (const k of Object.keys(cur)) {
    const v = cur[k];
    const hasValue = v !== undefined
      && v !== null
      && v !== ''
      && !(Array.isArray(v) && v.length === 0);
    if (hasValue) merged[k] = v;
  }
  return merged;
}

export interface ExpiringHydration {
  isRenewal: boolean;
  autoPopulated: boolean;
  layerCount: number;
  layers: ExpiringLayerRow[];
  terms: ExpiringTerms | null;
  coveredProps: CoveredPropRow[];
}

/** Hydrate the expiring-structure response (null input → no state change). */
export function hydrateExpiringResponse(
  exp: NpExpiringBundle | null | undefined,
  expiringCountFallback: number,
): ExpiringHydration | null {
  if (!exp) return null;
  const expLayers: ExpiringLayerRow[] = (exp.layers || []).map((rl, i) => ({
    layer: rl.layer_number || (i + 1),
    limit: strOrEmpty(rl.layer_limit),
    deductible: strOrEmpty(rl.attachment),
    annualAggLimit: strOrEmpty(rl.aggregate_limit),
    egnpi: strOrEmpty(rl.egnpi),
    rate: strRate(rl.rate),
    earnedPremium: strOrEmpty(rl.earned_premium), // preserve DB value; recalc will overwrite if rate present
    rol: strOrEmpty(rl.rol),                      // preserve DB value too
    mdp: strOrEmpty(rl.mdp),
    mdpPct: '',
    reinstatements: strOrEmpty(rl.num_reinstatements),
    reinstatementPct: strOrEmpty(rl.reinstatement_pct),
    aad: !!rl.annual_agg_deductible,
    aadAmount: strOrEmpty(rl.annual_agg_deductible),
    riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
    catCover:  rl.peril_scope === 'CAT'  || rl.peril_scope === 'BOTH',
    perilScope: rl.peril_scope || 'BOTH',
  }));
  // Always set layer count (even 0) so no ghost rows show before data arrives
  // Fallback to npDetail.expiringNumberOfLayers if no saved rows yet
  const recalced = expLayers.length > 0 ? expiringRecalc(expLayers, true) : [];
  const layerCount = recalced.length || expiringCountFallback;

  let terms: ExpiringTerms | null = null;
  if (exp.terms) {
    // Coerce DB numeric values to strings for controlled inputs, preserve all fields
    const t = exp.terms;
    terms = {
      egnpi:                 t.egnpi                 != null ? String(t.egnpi)                 : '',
      deductible:            t.deductible            != null ? String(t.deductible)            : '',
      risk_limit:            t.risk_limit            != null ? String(t.risk_limit)            : '',
      cat_limit:             t.cat_limit             != null ? String(t.cat_limit)             : '',
      brokerage_pct:         t.brokerage_pct         != null ? String(t.brokerage_pct)         : '',
      no_claims_bonus_pct:   t.no_claims_bonus_pct   != null ? String(t.no_claims_bonus_pct)   : '',
      profit_commission_pct: t.profit_commission_pct != null ? String(t.profit_commission_pct) : '',
      notes:                 t.notes                 ?? '',
    };
  }

  // coveredProps comes back at top level from the server (see nonProp.js
  // npExpiringGet). We also tolerate the legacy nested location for
  // forward-compat with any pre-fix rows where the code used to read
  // exp.terms.coveredProps.
  const nested = exp.terms?.coveredProps;
  const expCp = Array.isArray(exp.coveredProps)
    ? (exp.coveredProps as CoveredPropRow[])
    : (Array.isArray(nested) ? (nested as CoveredPropRow[]) : []);

  return {
    isRenewal: !!exp.isRenewal,
    autoPopulated: !!exp.autoPopulated,
    layerCount,
    layers: recalced,
    terms,
    coveredProps: expCp.length > 0 ? expCp : [emptyCoveredProp()],
  };
}
