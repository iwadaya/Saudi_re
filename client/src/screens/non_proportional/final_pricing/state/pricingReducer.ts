// state/pricingReducer.ts — Phase 4.1 (docs/frontend-hardening.md).
//
// The single strict-typed reducer that replaced NpFinalPricing's 50
// useState calls. State is grouped into coherent slices (layers, fq,
// workflow, modals, saveLifecycle, ui, refData); every transition that
// touches pricing numbers is the screen's original updater body moved
// here VERBATIM (TS casts only — zero runtime change). The golden-master
// suite pins the observable outputs; if an edit here changes one of its
// expectations, the edit changed pricing behaviour.
//
// Typing notes (the NumericLike trap, types/pricing.ts): the screen
// stores formatted strings ("2.80%", "1,250") and the server merges can
// inject raw numbers — fields that carry either are typed NumericLike,
// never number. All arithmetic goes through toN()/num() exactly as the
// legacy code did.

import { toN, pct, deriveComponentTotal as deriveComponentTotalTyped, deriveCombinedUwPrice } from '../formatters.js';

// shared/pricingMath's deriveComponentTotal strips %/commas itself at
// runtime (formatted strings are first-class inputs there), but its
// JSDoc contract says number. Bridge the NumericLike state fields
// through one typed alias instead of casting at every call site — the
// runtime function reference is unchanged.
const deriveComponentTotal = deriveComponentTotalTyped as unknown as (
  pureBurn: unknown, pareto: unknown, exposure: unknown,
  weightBurn: unknown, weightPareto: unknown, weightExposure: unknown,
  loading: unknown,
) => number;
import { calcTechRatio } from '../pricingHelpers.js';
import {
  emptyExpLayer,
  emptyStrLayer,
  syncExpLayerPricing,
  cascadeQuoteAttachments,
  updateQuotePricingLayer,
  mergeQuoteEngineResult,
} from '../fqQuoteMath.js';


// State model + action contract live in ./pricingState (split so both
// files stay under the 800-line screens budget); re-exported here so
// consumers can keep importing everything from the reducer module.
export * from './pricingState';
import type {
  NpPricingState,
  PricingAction,
  Setter,
  LayerPricing,
  LeadSetupRow,
  LayersSlice,
  FqSlice,
  WorkflowSlice,
  ModalsSlice,
  UiSlice,
  RefDataSlice,
  EngineLayerResult,
} from './pricingState';

// ── Local helpers (moved verbatim from the screen's effect bodies) ──────────

// Shared by the auto-column transitions below; identical to the
// effect-local helpers the screen used.
export const num = (v: unknown): number => {
  const x = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(x) ? x : 0;
};
export const fmtPct = (v: unknown): string => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x.toFixed(2) + '%' : '';
};
// Layer index: strip non-numeric prefix (e.g. "L1"→1, "Layer 2"→2, 3→3)
export const layerIdx = (v: unknown): number => {
  const x = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(x) ? x : NaN;
};

// Resolve a layer's expiring ROL against server-provided expKnown points
// (sorted [[idx, rolPct], ...]) — direct match, clamp, or interpolate.
const computeExpiringFor = (l: LayerPricing, i: number, expKnown: Array<[number, number]>): string => {
  if (!expKnown.length) return '';
  const curIdx = layerIdx(l.layer) || (i + 1);
  const direct = expKnown.find(([idx]) => idx === curIdx);
  if (direct) return fmtPct(direct[1]);
  if (curIdx <= expKnown[0][0]) return fmtPct(expKnown[0][1]);
  if (curIdx >= expKnown[expKnown.length - 1][0]) return fmtPct(expKnown[expKnown.length - 1][1]);
  for (let j = 0; j < expKnown.length - 1; j++) {
    const [i1, v1] = expKnown[j];
    const [i2, v2] = expKnown[j + 1];
    if (curIdx >= i1 && curIdx <= i2) {
      const t = (curIdx - i1) / (i2 - i1);
      return fmtPct(v1 + (v2 - v1) * t);
    }
  }
  return '';
};

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

// ── Transition bodies (verbatim moves) ──────────────────────────────────────

/** The screen's updateLayer() setLayers updater, moved verbatim. */
function editLayer(
  prev: LayerPricing[],
  idx: number,
  field: string,
  value: unknown,
  brokeragePct: unknown,
  taxesPct: unknown,
): LayerPricing[] {
  // All currently-editable layer fields are percentages or numeric weights.
  // Strip characters that can't appear in a valid percentage so users can't
  // enter letters or negative values — which previously silently flowed into
  // pricing calculations as 0 (letters) or wrong-sign results (negatives).
  const sanitized = typeof value === 'string'
    ? value.replace(/[^0-9.%]/g, '')
    : value;
  const next = [...prev];
  next[idx] = { ...next[idx], [field]: sanitized };

  // ── Auto-calc exposure weight as complement of (burn + pareto) ──
  // User edits Wt Burn % and Wt Pareto %; Wt Exp % auto-fills to keep
  // the three weights summing to 100 (clamped at 0 if burn+pareto ≥ 100).
  const balanceWeights = (prefix: 'risk' | 'cat') => {
    const b = Math.min(100, Math.max(0, parseFloat(next[idx][`${prefix}WeightBurn`] as string) || 0));
    const p = Math.min(100, Math.max(0, parseFloat(next[idx][`${prefix}WeightPareto`] as string) || 0));
    next[idx][`${prefix}WeightExposure`] = String(Math.max(0, Math.round(100 - b - p)));
  };
  if (field === 'riskWeightBurn' || field === 'riskWeightPareto') balanceWeights('risk');
  if (field === 'catWeightBurn' || field === 'catWeightPareto') balanceWeights('cat');

  const l = next[idx];

  // ── Recalc risk component ──
  if (l.risk) {
    const prevRiskTotal = l.riskTotalPrice; // before this update
    const riskTotal = deriveComponentTotal(
      l.riskPureBurn, l.riskPareto, l.riskExposure,
      l.riskWeightBurn, l.riskWeightPareto, l.riskWeightExposure, l.riskLoading,
    );
    next[idx].riskAvgBurnPareto = pct((toN(l.riskPureBurn) + toN(l.riskPareto)) || 0);
    next[idx].riskTotalPrice = pct(riskTotal || 0);
    if (field !== 'riskUwPrice') {
      // Sync UW price to total unless user has manually overridden it
      const uwMatchedPrev = !l.riskUwPrice || l.riskUwPrice === '0.00%' || l.riskUwPrice === prevRiskTotal;
      if (uwMatchedPrev) next[idx].riskUwPrice = pct(riskTotal || 0);
    }
  }

  // ── Recalc cat component ──
  if (l.cat) {
    const prevCatTotal = l.catTotalPrice;
    const catTotal = deriveComponentTotal(
      l.catPureBurn, l.catPareto, l.catExposure,
      l.catWeightBurn, l.catWeightPareto, l.catWeightExposure, l.catLoading,
    );
    next[idx].catAvgBurnPareto = pct((toN(l.catPureBurn) + toN(l.catPareto)) || 0);
    next[idx].catTotalPrice = pct(catTotal || 0);
    if (field !== 'catUwPrice') {
      const uwMatchedPrev = !l.catUwPrice || l.catUwPrice === '0.00%' || l.catUwPrice === prevCatTotal;
      if (uwMatchedPrev) next[idx].catUwPrice = pct(catTotal || 0);
    }
  }

  // ── Combined uwPrice = sum of active component UW prices ──
  const combined = deriveCombinedUwPrice(next[idx]);
  next[idx].totalPrice = pct(combined || 0);
  if (field !== 'uwPrice') {
    next[idx].uwPrice = next[idx].uwPrice || pct(combined || 0);
  }

  // ── Margins / ratios ──
  const rp = toN(l.reinsurerPricing);
  const ep = toN(l.expiringPricing);
  if (rp && ep) next[idx].reinsurerMargin = pct(((ep - rp) / ep) * 100);
  const techRatio = calcTechRatio(
    toN(l.historicalMargin),
    toN(brokeragePct),
    toN(taxesPct),
  );
  if (techRatio !== 0) next[idx].technicalRatio = pct(techRatio);

  return next;
}

/** The auto-column effect's applyColumns() updater, moved verbatim. */
function applyAutoColumns(
  prev: LayerPricing[],
  snap: { reinsurer: string[]; lead: string[] },
  expKnown: Array<[number, number]> | null,
  brokeragePct: unknown,
  taxesPct: unknown,
): LayerPricing[] {
  return prev.map((l, i) => {
    // If the layer count changed during the async gap (user added/removed a
    // layer), snap.reinsurer/lead are indexed to the old list — skip them
    // to avoid writing one layer's ROL onto another.
    const snapAligned = snap.reinsurer.length === prev.length;
    // Guard against stale ROLs saved under the old Rate-%-of-EPI scale: a
    // reinsurer ROL above 500% is physically impossible for a sensible XL
    // layer, so treat it as stale and discard (re-entry / re-compute fixes it).
    const rawReins = snapAligned && snap.reinsurer[i] !== undefined ? snap.reinsurer[i] : '';
    const reins = toN(rawReins) > 500 ? '' : (rawReins || '');
    const lead = (snapAligned && snap.lead[i] !== undefined ? snap.lead[i] : '') || '';
    const exp = expKnown ? computeExpiringFor(l, i, expKnown) : '';

    const next = { ...l };
    // Always write — these are computed display columns, not user-entry fields
    if (reins) next.reinsurerPricing = reins;
    if (lead) next.leadPricing = lead;
    if (exp) next.expiringPricing = exp;

    // Recalc margin columns (historicalMargin computed by loss-based async effect)
    const rp = num(next.reinsurerPricing);
    const ep = num(next.expiringPricing);
    if (rp && ep) next.reinsurerMargin = fmtPct(((ep - rp) / ep) * 100);
    // Technical Ratio — single source of truth in pricingHelpers
    const techRatio = calcTechRatio(
      num(next.historicalMargin),
      num(brokeragePct),
      num(taxesPct),
    );
    if (techRatio !== 0) next.technicalRatio = fmtPct(techRatio);
    return next;
  });
}

/** The historical-margin effect's setLayers updater, moved verbatim. */
function applyHistoricalMargins(
  prev: LayerPricing[],
  largeByYear: Map<string, number[]>,
  catByYear: Map<string, number[]>,
  bothByYear: Map<string, number[]>,
  brokeragePct: unknown,
  taxesPct: unknown,
): LayerPricing[] {
  return prev.map((l) => {
    const lim = toN(l.limit);
    const ded = toN(l.deductible);
    if (!lim) return l;

    // basePrem: use reinsurer pricing if set, fall back to lead pricing
    const pricingPct = toN(l.reinsurerPricing) || toN(l.leadPricing);
    if (!pricingPct) return l;

    // Choose correct loss pool for this layer's peril cover
    const byYear = (l.risk && l.cat) ? bothByYear : l.cat ? catByYear : largeByYear;
    const years = [...byYear.keys()];
    if (!years.length) return l;

    const basePrem = (pricingPct / 100) * lim;
    const noReinst = parseInt(String(l.noReinst ?? l.reinstatements ?? '').replace(/[^0-9]/g, ''), 10) || 0;
    const reinstPctRaw = parseFloat(String(l.reinstPct ?? l.reinstatementPct ?? '').replace(/%/g, '')) || 0;
    const reinstPct01 = reinstPctRaw / 100;

    // Maximum total capacity this layer can absorb in one year:
    //   original cover (1 × limit) + noReinst reinstatements
    const maxCapacity = lim * (1 + noReinst);

    let totalLoss = 0, totalIncome = 0;
    for (const incurreds of byYear.values()) {
      // Process losses sequentially within the year.
      // Track remaining capacity: starts at maxCapacity, decrements as losses hit the layer.
      // Each unit of capacity used above the first 'lim' triggers a reinstatement premium.
      let remainingCapacity = maxCapacity;
      let annualLayerLoss = 0;
      let reinstPrem = 0;

      for (const inc of incurreds) {
        if (remainingCapacity <= 0) break; // layer fully exhausted for the year
        const lossHit = Math.max(0, Math.min(inc - ded, remainingCapacity));
        if (lossHit <= 0) continue;

        annualLayerLoss += lossHit;
        remainingCapacity -= lossHit;

        // Reinstatement premium: charged for each unit of reinstatement capacity used.
        // Reinstatement capacity starts after the first 'lim' is consumed.
        // Units used beyond first lim = how much of reinstatement cover this loss consumed.
        const usedBeforeThisLoss = maxCapacity - (remainingCapacity + lossHit);
        const firstLimRemaining = Math.max(0, lim - usedBeforeThisLoss);
        // portion of this loss that consumed reinstatement capacity (beyond first lim)
        const reinstUsed = Math.max(0, lossHit - firstLimRemaining);
        if (noReinst > 0 && reinstPct01 > 0 && reinstUsed > 0) {
          reinstPrem += (reinstUsed / lim) * reinstPct01 * basePrem;
        }
      }

      totalLoss += annualLayerLoss;
      totalIncome += basePrem + reinstPrem;
    }

    const avgLoss = totalLoss / years.length;
    const avgIncome = totalIncome / years.length;
    if (!avgIncome) return l;

    const brok = toN(brokeragePct);
    const taxes = toN(taxesPct);
    const lossRatio = (avgLoss / avgIncome) * 100;
    const histMarginPct = 100 - lossRatio - brok - taxes;
    return { ...l, historicalMargin: Number.isFinite(histMarginPct) ? pct(histMarginPct) : l.historicalMargin };
  });
}

/** The tech-ratio propagation effect's setLayers updater, moved verbatim. */
function recomputeTechRatios(prev: LayerPricing[], brokeragePct: unknown, taxesPct: unknown): LayerPricing[] {
  return prev.map((l) => {
    const histM = toN(l.historicalMargin);
    if (!histM) return l;
    const techRatio = calcTechRatio(histM, toN(brokeragePct), toN(taxesPct));
    return { ...l, technicalRatio: pct(techRatio) };
  });
}

/** runCalcEngine's setLayers merge, moved verbatim. */
function applyEngineResults(prev: LayerPricing[], results: EngineLayerResult[]): LayerPricing[] {
  const next = prev.map((l, i) => {
    const r = results.find(res => res.idx === i);
    if (!r) return l;

    const merged = { ...l };

    // ── Apply RISK component results ──
    if (r.risk) {
      merged.riskPureBurn = r.risk.pureBurn || l.riskPureBurn;
      merged.riskPareto = r.risk.pareto || l.riskPareto;
      merged.riskExposure = r.risk.exposureRating || l.riskExposure;
      merged.riskPrAttach = r.risk.prAttach || l.riskPrAttach;
      merged.riskPrExhaust = r.risk.prExhaust || l.riskPrExhaust;
      const riskBP = toN(merged.riskPureBurn) + toN(merged.riskPareto);
      merged.riskAvgBurnPareto = pct(riskBP || 0);
      const riskTotal = deriveComponentTotal(
        merged.riskPureBurn, merged.riskPareto, merged.riskExposure,
        merged.riskWeightBurn || '50', merged.riskWeightPareto || '0',
        merged.riskWeightExposure || '50', merged.riskLoading || '15',
      );
      merged.riskTotalPrice = pct(riskTotal || 0);
      // Seed UW price = total ROL unless user has manually diverged them
      const riskUwWasDefault = !merged.riskUwPrice || merged.riskUwPrice === '0.00%' || merged.riskUwPrice === l.riskTotalPrice;
      if (riskUwWasDefault) merged.riskUwPrice = merged.riskTotalPrice;
    }

    // ── Apply CAT component results ──
    if (r.cat) {
      merged.catPureBurn = r.cat.pureBurn || l.catPureBurn;
      merged.catPareto = r.cat.pareto || l.catPareto;
      merged.catExposure = r.cat.exposureRating || l.catExposure;
      merged.catPrAttach = r.cat.prAttach || l.catPrAttach;
      merged.catPrExhaust = r.cat.prExhaust || l.catPrExhaust;
      const catBP = toN(merged.catPureBurn) + toN(merged.catPareto);
      merged.catAvgBurnPareto = pct(catBP || 0);
      const catTotal = deriveComponentTotal(
        merged.catPureBurn, merged.catPareto, merged.catExposure,
        merged.catWeightBurn || '50', merged.catWeightPareto || '0',
        merged.catWeightExposure || '50', merged.catLoading || '15',
      );
      merged.catTotalPrice = pct(catTotal || 0);
      const catUwWasDefault = !merged.catUwPrice || merged.catUwPrice === '0.00%' || merged.catUwPrice === l.catTotalPrice;
      if (catUwWasDefault) merged.catUwPrice = merged.catTotalPrice;
    }

    // ── Combined uwPrice ──
    const combined = deriveCombinedUwPrice(merged);
    merged.totalPrice = pct(combined || 0);
    if (!merged.uwPrice) merged.uwPrice = merged.totalPrice;

    return merged;
  });
  return next;
}

// ── The reducer ─────────────────────────────────────────────────────────────

export function pricingReducer(state: NpPricingState, action: PricingAction): NpPricingState {
  switch (action.type) {
    case 'layers/set': {
      const slice = setSliceKey(state.layers, action.key, action.next as Setter<LayersSlice[keyof LayersSlice]>);
      return slice === state.layers ? state : { ...state, layers: slice };
    }
    case 'fq/set': {
      const slice = setSliceKey(state.fq, action.key, action.next as Setter<FqSlice[keyof FqSlice]>);
      return slice === state.fq ? state : { ...state, fq: slice };
    }
    case 'workflow/set': {
      const slice = setSliceKey(state.workflow, action.key, action.next as Setter<WorkflowSlice[keyof WorkflowSlice]>);
      return slice === state.workflow ? state : { ...state, workflow: slice };
    }
    case 'modals/set': {
      const slice = setSliceKey(state.modals, action.key, action.next as Setter<ModalsSlice[keyof ModalsSlice]>);
      return slice === state.modals ? state : { ...state, modals: slice };
    }
    case 'ui/set': {
      const slice = setSliceKey(state.ui, action.key, action.next as Setter<UiSlice[keyof UiSlice]>);
      return slice === state.ui ? state : { ...state, ui: slice };
    }
    case 'refData/set': {
      const slice = setSliceKey(state.refData, action.key, action.next as Setter<RefDataSlice[keyof RefDataSlice]>);
      return slice === state.refData ? state : { ...state, refData: slice };
    }

    // ── save lifecycle ──
    case 'save/start':
      return {
        ...state,
        saveLifecycle: {
          ...state.saveLifecycle,
          saveState: { ...state.saveLifecycle.saveState, status: 'saving', error: null },
        },
      };
    case 'save/saved':
      return {
        ...state,
        saveLifecycle: { ...state.saveLifecycle, saveState: { status: 'saved', at: action.at, error: null } },
      };
    case 'save/failed':
      return {
        ...state,
        saveLifecycle: { ...state.saveLifecycle, saveState: { status: 'error', at: action.at, error: action.error } },
      };
    case 'save/lock':
      return Object.is(state.saveLifecycle.lastUpdatedAt, action.lastUpdatedAt)
        ? state
        : { ...state, saveLifecycle: { ...state.saveLifecycle, lastUpdatedAt: action.lastUpdatedAt } };

    // ── calc-engine lifecycle ──
    case 'engine/start': {
      const ui = action.structureIndex == null
        ? { ...state.ui, calcEngineRunning: true, calcEngineError: '' }
        : { ...state.ui, runningStructures: { ...state.ui.runningStructures, [action.structureIndex]: true }, calcEngineError: '' };
      return { ...state, ui };
    }
    case 'engine/finish': {
      if (action.structureIndex == null) return { ...state, ui: { ...state.ui, calcEngineRunning: false } };
      const n = { ...state.ui.runningStructures };
      delete n[action.structureIndex];
      return { ...state, ui: { ...state.ui, runningStructures: n } };
    }
    case 'engine/error':
      return { ...state, ui: { ...state.ui, calcEngineError: action.message } };

    // ── treaty-mode layer transitions ──
    case 'layers/edit': {
      // Defence in depth: refuse to mutate layer state once the offer is in
      // a terminal status (SIGNED / NTU / DECLINED). The NpLayerTable
      // already disables its inputs via the `disabled` prop, but a stale
      // browser tab + devtools or a programmatic call could still hit this
      // path. The backend would reject the eventual save anyway, but we
      // shouldn't put the local state in a divergent shape.
      if (['SIGNED', 'NTU', 'DECLINED'].includes(state.workflow.offerStatus)) return state;
      return {
        ...state,
        layers: {
          ...state.layers,
          layers: editLayer(state.layers.layers, action.index, action.field, action.value, action.brokeragePct, action.taxesPct),
        },
      };
    }
    case 'layers/editLeadSetup': {
      const next = [...state.layers.leadSetup];
      next[action.index] = { ...next[action.index], [action.field]: action.value } as LeadSetupRow;
      return { ...state, layers: { ...state.layers, leadSetup: next } };
    }
    case 'layers/applyAutoColumns':
      return {
        ...state,
        layers: {
          ...state.layers,
          layers: applyAutoColumns(state.layers.layers, action.snap, action.expKnown, action.brokeragePct, action.taxesPct),
        },
      };
    case 'layers/applyHistoricalMargins':
      return {
        ...state,
        layers: {
          ...state.layers,
          layers: applyHistoricalMargins(
            state.layers.layers,
            action.largeByYear, action.catByYear, action.bothByYear,
            action.brokeragePct, action.taxesPct,
          ),
        },
      };
    case 'layers/recomputeTechRatios':
      return {
        ...state,
        layers: {
          ...state.layers,
          layers: recomputeTechRatios(state.layers.layers, action.brokeragePct, action.taxesPct),
        },
      };
    case 'layers/applyEngineResults':
      return {
        ...state,
        layers: { ...state.layers, layers: applyEngineResults(state.layers.layers, action.results) },
      };

    // ── quote-mode (FQ) transitions ──
    case 'fq/editExpLayer': {
      const { index, field, value } = action;
      const next = state.fq.expLayers.map((row, idx) => {
        if (idx !== index) return row;
        const updated = { ...row, [field]: value };
        return ['rate', 'rol', 'limit', 'egnpi'].includes(field)
          ? syncExpLayerPricing(updated, field)
          : updated;
      });
      // Limit on any layer or attachment on layer 0 cascades the rest.
      const cascaded = (field === 'limit' || (field === 'attachment' && index === 0))
        ? cascadeQuoteAttachments(next)
        : next;
      return { ...state, fq: { ...state.fq, expLayers: cascaded } };
    }
    case 'fq/setNumExpLayers': {
      const n = action.n;
      const prev = state.fq.expLayers;
      let expLayers = prev;
      if (n !== prev.length) {
        if (n < prev.length) expLayers = prev.slice(0, n);
        else {
          const grown = prev.slice();
          for (let i = prev.length; i < n; i += 1) grown.push(emptyExpLayer(i));
          expLayers = cascadeQuoteAttachments(grown);
        }
      }
      return { ...state, fq: { ...state.fq, numExpLayers: n, expLayers } };
    }
    case 'fq/editStructureLayer': {
      const { structureIndex, layerIndex, field, value, curve } = action;
      const clientStructures = state.fq.clientStructures.map((s, i) => {
        if (i !== structureIndex) return s;
        const updated = s.layers.map((row, j) => (
          j === layerIndex ? updateQuotePricingLayer(row, field, value, { curve }) : row
        ));
        const cascaded = (field === 'limit' || (field === 'attachment' && layerIndex === 0))
          ? cascadeQuoteAttachments(updated)
          : updated;
        return { ...s, layers: cascaded };
      });
      return { ...state, fq: { ...state.fq, clientStructures } };
    }
    case 'fq/addStructure':
      return {
        ...state,
        fq: {
          ...state.fq,
          clientStructures: [
            ...state.fq.clientStructures,
            { id: `str-${action.idBase}-${state.fq.clientStructures.length}`, layers: [emptyStrLayer(0, action.defaults)] },
          ],
          approvedStructures: [...state.fq.approvedStructures, false],
        },
      };
    case 'fq/addStructureLayer': {
      const clientStructures = state.fq.clientStructures.map((s, i) => {
        if (i !== action.structureIndex) return s;
        return { ...s, layers: cascadeQuoteAttachments([...s.layers, emptyStrLayer(s.layers.length, action.defaults)]) };
      });
      return { ...state, fq: { ...state.fq, clientStructures } };
    }
    case 'fq/removeStructureLayer': {
      const clientStructures = state.fq.clientStructures.map((s, i) => {
        if (i !== action.structureIndex) return s;
        return { ...s, layers: cascadeQuoteAttachments(s.layers.filter((_, j) => j !== action.layerIndex)) };
      });
      return { ...state, fq: { ...state.fq, clientStructures } };
    }
    case 'fq/removeStructure': {
      const sIdx = action.index;
      const prevModal = state.modals.pricingAnalysisModal;
      let pricingAnalysisModal = prevModal;
      if (prevModal.structureIndex === sIdx) pricingAnalysisModal = { open: false, structureIndex: null };
      else if (Number.isInteger(prevModal.structureIndex) && (prevModal.structureIndex as number) > sIdx) {
        pricingAnalysisModal = { ...prevModal, structureIndex: (prevModal.structureIndex as number) - 1 };
      }
      return {
        ...state,
        fq: {
          ...state.fq,
          clientStructures: state.fq.clientStructures.filter((_, i) => i !== sIdx),
          approvedStructures: state.fq.approvedStructures.filter((_, i) => i !== sIdx),
        },
        modals: pricingAnalysisModal === prevModal
          ? state.modals
          : { ...state.modals, pricingAnalysisModal },
      };
    }
    case 'fq/setApprovedStructure':
      return {
        ...state,
        fq: {
          ...state.fq,
          approvedStructures: state.fq.clientStructures.map((_, i) => (
            i === action.index ? action.checked : !!state.fq.approvedStructures[i]
          )),
        },
      };
    case 'fq/setCobToggle': {
      const { scope, cobId, layerIndex, currentFlag } = action;
      const manualScope = { ...(state.fq.cobManual[scope] || {}) };
      const manualArr = [...(manualScope[cobId as string] || [])];
      manualArr[layerIndex] = true;
      manualScope[cobId as string] = manualArr;
      const toggleScope = { ...(state.fq.cobToggles[scope] || {}) };
      const flags = [...(toggleScope[cobId as string] || [])];
      flags[layerIndex] = !currentFlag;
      toggleScope[cobId as string] = flags;
      return {
        ...state,
        fq: {
          ...state.fq,
          cobManual: { ...state.fq.cobManual, [scope]: manualScope },
          cobToggles: { ...state.fq.cobToggles, [scope]: toggleScope },
        },
      };
    }
    case 'fq/setCobUwLimit':
      return {
        ...state,
        fq: {
          ...state.fq,
          quoteCobUwLimits: {
            ...state.fq.quoteCobUwLimits,
            [action.scope]: { ...(state.fq.quoteCobUwLimits[action.scope] || {}), [action.cobId as string]: action.value },
          },
        },
      };
    case 'fq/applyQuoteEngineResults': {
      const clientStructures = state.fq.clientStructures.map((structure, sIdx) => {
        const scope = structure.id || `str-${sIdx}`;
        return {
          ...structure,
          layers: (structure.layers || []).map((layer, lIdx) => {
            const result = action.byKey.get(`${scope}:${layer.id ?? lIdx}`);
            return result ? mergeQuoteEngineResult(layer, result) : layer;
          }),
        };
      });
      return { ...state, fq: { ...state.fq, clientStructures } };
    }

    // ── modal payloads ──
    case 'modals/openBenchmark':
      return {
        ...state,
        modals: {
          ...state.modals,
          benchmarkModal: { open: true, scope: action.scope, sourceLabel: action.sourceLabel, sourceLayers: action.sourceLayers },
        },
      };
    case 'modals/closeBenchmark':
      return {
        ...state,
        modals: { ...state.modals, benchmarkModal: { ...state.modals.benchmarkModal, open: false } },
      };
    case 'modals/openPricingGraph':
      return {
        ...state,
        modals: {
          ...state.modals,
          pricingGraphModal: { open: true, sourceLabel: action.sourceLabel, structure: action.structure },
        },
      };
    case 'modals/closePricingGraph':
      return {
        ...state,
        modals: { ...state.modals, pricingGraphModal: { open: false, sourceLabel: '', structure: null } },
      };
    case 'modals/openPricingAnalysis':
      return {
        ...state,
        modals: { ...state.modals, pricingAnalysisModal: { open: true, structureIndex: action.structureIndex } },
      };
    case 'modals/closePricingAnalysis':
      return {
        ...state,
        modals: { ...state.modals, pricingAnalysisModal: { open: false, structureIndex: null } },
      };

    // ── contract switch — mirror the legacy reset effect exactly ──
    case 'contract/reset':
      return {
        ...state,
        layers: { ...state.layers, layers: [], leadSetup: [] },
        ui: { ...state.ui, loading: true },
        workflow: { ...state.workflow, offerStatus: '' },
        modals: {
          ...state.modals,
          showDeclineModal: false,
          showOfferModal: false,
          pricingGraphModal: { open: false, sourceLabel: '', structure: null },
          pricingAnalysisModal: { open: false, structureIndex: null },
        },
        fq: {
          ...state.fq,
          quoteStructures: [],
          approvedStructures: [],
          quotePricing: {},
          // Quote-mode scaffolding state — must reset on contract switch
          // or values from the previous quote leak into the new one.
          expLayers: Array.from({ length: 3 }, (_, i) => emptyExpLayer(i)),
          numExpLayers: 3,
          clientStructures: [],
          selectedCobs: [],
          quoteCobUwLimits: {},
          cobToggles: {},
          cobManual: {},
        },
      };

    default:
      return state;
  }
}

export default pricingReducer;
