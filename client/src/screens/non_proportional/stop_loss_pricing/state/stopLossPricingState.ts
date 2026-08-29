// state/stopLossPricingState.ts — typed state model + pure derivation
// pipeline for the NP Stop Loss Pricing screen (Phase 4.2 decomposition
// of NpStopLossPricing.jsx).
//
// Everything here is pure: fixture in, numbers out. The hook
// (hooks/useStopLossPricingState.ts) wires these builders to AppContext
// and useScreenSave; the orchestrator only renders.
//
// Every function body was moved VERBATIM from the pre-refactor screen —
// same parsing quirks, same null/'' handling, same on-level chain —
// because goldenMaster.test.jsx pins the observable output byte-for-byte.
// Do not "clean up" the arithmetic here without updating the engine and
// its contract first.

import { priceStopLoss } from '../../../../logic/stopLossPricing';
import { computeOnLevelFactors } from '../../../../../../shared/onLevel.js';
import type { StopLossPricingBundle } from '../../../../types/pricing';

export const SLICE_KEY = 'npStopLossInputs';

const DEFAULT_YEARS = 10;

// ── Slice / input model ─────────────────────────────────────────────────────

/** One layer of cover as written into the slice by the Structure page. */
export interface LayerCoverInput {
  attachmentLossRatio?: unknown;
  limitLossRatio?: unknown;
  epi?: unknown;
}

/** Raw losses ($) per UW year as stored in the slice. */
export interface YearAggregateRow {
  year: number;
  aggregate: unknown;
}

export type StopLossArgs = Parameters<typeof priceStopLoss>[0];
export type StopLossResult = ReturnType<typeof priceStopLoss>;

/**
 * The screen's working inputs — DEFAULT_INPUTS merged over the
 * `npStopLossInputs` AppContext slice. Field types mirror what the UI
 * writes (strings for text inputs, boolean for the MC toggle); values
 * hydrated from the server pass through unchanged.
 */
export interface StopLossInputs {
  // Layer cover (attach LR / limit LR / EPI per layer) lives in
  // `layers` and is owned by the Structure page; this screen only
  // edits the engine inputs below.
  layers: LayerCoverInput[];
  yearlyAggregates: YearAggregateRow[];
  freqLambda: string;
  severityType: string;
  sevMean: string;
  sevCv: string;
  paretoAlpha: string;
  paretoTheta: string;
  weightBurningCost: string;
  weightExposureRating: string;
  weightMonteCarlo: string;
  loading: string;
  useMonteCarlo: boolean;
  mcTrials: string;
  mcSeed: string;
}

export const DEFAULT_INPUTS: StopLossInputs = {
  layers: [],
  yearlyAggregates: [],
  freqLambda: '',
  severityType: 'lognormal',
  sevMean: '',
  sevCv: '',
  paretoAlpha: '',
  paretoTheta: '',
  weightBurningCost: '50',
  weightExposureRating: '50',
  weightMonteCarlo: '0',
  loading: '20',
  useMonteCarlo: false,
  mcTrials: '10000',
  mcSeed: '1',
};

/** Loose treaty-detail bag from AppContext — wire-shaped, not state. */
export type NpDetailLike = Record<string, unknown>;

/** Loose numeric parse used across the screen ('' / null → null). */
export const toN = (v: unknown): number | null => {
  if (v === '' || v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-eE]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── Premiums / rate changes from the relational EGNPI table ────────────────

export interface PremiumData {
  premiums: Map<number, number>;
  rateChanges: Map<number, number>;
}

export const EMPTY_PREMIUM_DATA: PremiumData = {
  premiums: new Map<number, number>(),
  rateChanges: new Map<number, number>(),
};

/**
 * Parse the egnpi-year response into premium / rate-change maps.
 * Legacy server builds wrapped the rows in {rows} / {years}.
 */
export function parseEgnpiRows(rows: unknown): PremiumData {
  const loose = rows as { rows?: Array<Record<string, unknown>>; years?: Array<Record<string, unknown>> } | null | undefined;
  const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : (loose?.rows || loose?.years || []);
  const premiums = new Map<number, number>();
  const rateChanges = new Map<number, number>();
  for (const r of list) {
    const y = Number(r.uwYear ?? r.uw_year);
    if (!Number.isFinite(y)) continue;
    const egnpi = Number(String(r.egnpi ?? '').replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(egnpi)) premiums.set(y, egnpi);
    const rc = Number(String(r.rate_change_pct ?? r.rateChangePct ?? '').replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(rc)) rateChanges.set(y, rc);
  }
  return { premiums, rateChanges };
}

// ── Derived pipeline ────────────────────────────────────────────────────────

/**
 * Underwriting-year experience window: [experienceStartYear, startYear).
 * Falls back to a trailing DEFAULT_YEARS window when Treaty Detail has
 * no usable years.
 */
export function buildYearRange(npDetail: NpDetailLike): number[] {
  const uwYear = parseInt(String(npDetail.startYear || new Date().getFullYear()), 10);
  const startYear = parseInt(
    String(npDetail.experienceStartYear || npDetail.startYear || (uwYear - DEFAULT_YEARS + 1)),
    10,
  );
  const years: number[] = [];
  for (let y = startYear; y < uwYear; y++) years.push(y);
  return years.length > 0 ? years : Array.from({ length: DEFAULT_YEARS }, (_, i) => new Date().getFullYear() - DEFAULT_YEARS + i);
}

/**
 * One editable row per year in the experience window. Empty aggregates
 * are kept so the burning-cost denominator includes zero-loss years
 * (see annualiseLoss).
 */
export function buildYearlyRows(yearRange: number[], savedAggregates: YearAggregateRow[] | undefined): YearAggregateRow[] {
  const saved = savedAggregates || [];
  const savedMap = new Map(saved.map((r) => [r.year, r.aggregate] as [number, unknown]));
  return yearRange.map((year) => ({
    year,
    aggregate: savedMap.has(year) ? savedMap.get(year) : '',
  }));
}

/** One computed burning-cost table row (per UW year). */
export interface BurningCostRow {
  year: number;
  rawPremium: number | null;
  onLevelFactor: number;
  adjustedPremium: number | null;
  aggregate: number | null;
  aggregateRaw: unknown;
  lossRatio: number | null;
}

/**
 * On-level burning cost rows: Premium (adjusted), Aggregate Loss, Loss
 * Ratio, and the on-level factor — LR = aggregate ÷ (EGNPI × Π(1+rᵢ)).
 */
export function buildBurningCostRows(
  yearRange: number[],
  yearlyRows: YearAggregateRow[],
  premiumData: PremiumData,
): BurningCostRow[] {
  const onLevel = computeOnLevelFactors(yearRange, premiumData.rateChanges);
  return yearlyRows.map((r) => {
    const rawPremium = premiumData.premiums.get(r.year);
    const factor = onLevel.get(r.year) ?? 1;
    const hasPremium = typeof rawPremium === 'number' && Number.isFinite(rawPremium);
    const adjustedPremium = hasPremium ? rawPremium * factor : null;
    const aggregate = toN(r.aggregate);
    const lossRatio = (aggregate != null && adjustedPremium && adjustedPremium > 0)
      ? aggregate / adjustedPremium
      : null;
    return {
      year: r.year,
      rawPremium: hasPremium ? rawPremium : null,
      onLevelFactor: factor,
      adjustedPremium,
      aggregate,
      aggregateRaw: r.aggregate,
      lossRatio,
    };
  });
}

/**
 * Layer count from Treaty Detail — pad / truncate so this screen stays
 * in lock-step with the Structure page (1..20, default 1).
 */
export function buildLayerCount(npDetail: NpDetailLike): number {
  const n = parseInt(String(npDetail.numberOfLayers || npDetail.number_of_layers || '1'), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 1;
}

/** Layer rows normalised for display: missing fields become ''. */
export interface NormalizedLayer {
  attachmentLossRatio: unknown;
  limitLossRatio: unknown;
  epi: unknown;
}

/**
 * Layers sourced from the Structure page (`inputs.layers`), padded /
 * truncated to the Treaty Detail count.
 */
export function buildLayers(savedLayers: unknown, layerCount: number): NormalizedLayer[] {
  const saved = Array.isArray(savedLayers) ? (savedLayers as LayerCoverInput[]) : [];
  const out: NormalizedLayer[] = [];
  for (let i = 0; i < layerCount; i++) {
    const s = saved[i];
    out.push(s
      ? { attachmentLossRatio: s.attachmentLossRatio ?? '', limitLossRatio: s.limitLossRatio ?? '', epi: s.epi ?? '' }
      : { attachmentLossRatio: '', limitLossRatio: '', epi: '' });
  }
  return out;
}

/**
 * Shared engine args (frequency / severity / MC / blend / loading).
 * Per-layer args extend this with attach / limit / epi and a
 * layer-specific normalised yearlyAggregates array.
 */
export function buildSharedEngineArgs(inputs: StopLossInputs): StopLossArgs {
  const args: StopLossArgs = {
    loading: toN(inputs.loading) ?? 0,
    weights: {
      burningCost: toN(inputs.weightBurningCost) ?? 0,
      exposureRating: toN(inputs.weightExposureRating) ?? 0,
      monteCarlo: toN(inputs.weightMonteCarlo) ?? 0,
    },
    useMonteCarlo: !!inputs.useMonteCarlo,
    monteCarlo: { nTrials: toN(inputs.mcTrials) ?? 10_000, seed: toN(inputs.mcSeed) ?? 1 },
  };
  const lambda = toN(inputs.freqLambda);
  if (lambda !== null) {
    args.frequency = { lambda };
    if (inputs.severityType === 'lognormal') {
      const mean = toN(inputs.sevMean);
      const cv = toN(inputs.sevCv);
      if (mean !== null && cv !== null) args.severity = { type: 'lognormal', mean, cv };
    } else if (inputs.severityType === 'pareto') {
      const alpha = toN(inputs.paretoAlpha);
      const theta = toN(inputs.paretoTheta);
      if (alpha !== null && theta !== null) args.severity = { type: 'pareto', alpha, theta };
    }
  }
  return args;
}

/**
 * Per-layer engine args. The burning cost denominator is the same set
 * of yearly LRs for every layer, but the layer's own EPI is used to
 * convert LR → absolute aggregate so the engine's layer math lands in
 * the right currency space when EPI differs per layer.
 *
 * Window contract (see buildYearlyRows / annualiseLoss): every year of the
 * experience window stays in the burning-cost denominator. A BLANK aggregate
 * is a zero-loss year, not a missing year — it is fed to the engine as
 * aggregate 0. (The old row filter `lossRatio != null` dropped blank years,
 * annualising over entered years only and overstating the burning cost by
 * windowYears / enteredYears.) A year with an ENTERED aggregate but no
 * usable EGNPI premium cannot produce a loss ratio; it is excluded from
 * numerator AND denominator with an explicit warning instead of a silent
 * drop. When no year has a computable loss ratio at all, no burning-cost
 * input is emitted (unchanged: the engine then prices on exposure only).
 */
export function buildLayerEngineArgs(
  layers: NormalizedLayer[],
  sharedEngineArgs: StopLossArgs,
  burningCostRows: BurningCostRow[],
): StopLossArgs[] {
  const engineRows: Array<{ year: number; lossRatio: number }> = [];
  const warnings: string[] = [];
  let computableRows = 0;
  for (const r of burningCostRows) {
    if (r.lossRatio != null) {
      engineRows.push({ year: r.year, lossRatio: r.lossRatio });
      computableRows += 1;
    } else if (r.aggregate == null || r.aggregate === 0) {
      // Blank (or explicit-zero) aggregate → zero-loss year, kept in the window.
      engineRows.push({ year: r.year, lossRatio: 0 });
    } else {
      warnings.push(`Year ${r.year} has an aggregate loss but no EGNPI premium — it was excluded from the burning cost.`);
    }
  }
  return layers.map((l) => {
    const args: StopLossArgs = { ...sharedEngineArgs };
    args.attachmentLossRatio = toN(l.attachmentLossRatio);
    args.limitLossRatio = toN(l.limitLossRatio);
    args.epi = toN(l.epi);
    const epi = args.epi;
    if (epi != null && epi > 0 && computableRows > 0) {
      args.yearlyAggregates = engineRows.map((r) => ({ year: r.year, aggregate: r.lossRatio * epi }));
      if (warnings.length > 0) args.warnings = [...warnings];
    }
    return args;
  });
}

/** Fallback when no layer produced a result (defensive — layerCount ≥ 1). */
export const EMPTY_RESULT: StopLossResult = {
  attachment: 0,
  limit: 0,
  blended: { annualLoss: 0, rol: 0, totalRate: 0 },
  burningCost: null,
  exposureRating: null,
  monteCarlo: null,
  warnings: [],
};

// ── Persistence snapshots ──────────────────────────────────────────────────

/** Per-layer headline numbers persisted alongside the layer-1 view. */
export interface LayerOutputSnapshot {
  layer: number;
  attachment: number;
  limit: number;
  blended: StopLossResult['blended'];
  burningCostRol: number | null;
  exposureRol: number | null;
  monteCarloRol: number | null;
}

export interface StopLossOutputsSnapshot {
  attachment: number;
  limit: number;
  blended: StopLossResult['blended'];
  burningCost: { annualLoss: number; rol: number; nYears: number } | null;
  exposureRating: StopLossResult['exposureRating'];
  monteCarlo: {
    annualLoss: number;
    rol: number;
    cv: number;
    hitFrequency: number;
    percentiles: NonNullable<StopLossResult['monteCarlo']>['percentiles'];
    nTrials: number;
  } | null;
  warnings: string[];
  layers: LayerOutputSnapshot[];
}

/**
 * Snapshot the result for the persist payload. Top-level fields keep
 * the layer-1 view (back-compat); `layers` carries the per-layer
 * headline numbers so the saved record matches what the user sees on
 * screen for multi-layer covers.
 */
export function buildOutputsSnapshot(result: StopLossResult, layerResults: StopLossResult[]): StopLossOutputsSnapshot {
  return {
    attachment: result.attachment,
    limit: result.limit,
    blended: result.blended,
    burningCost: result.burningCost
      ? { annualLoss: result.burningCost.annualLoss, rol: result.burningCost.rol, nYears: result.burningCost.nYears }
      : null,
    exposureRating: result.exposureRating,
    monteCarlo: result.monteCarlo
      ? {
          annualLoss: result.monteCarlo.annualLoss,
          rol: result.monteCarlo.rol,
          cv: result.monteCarlo.cv,
          hitFrequency: result.monteCarlo.hitFrequency,
          percentiles: result.monteCarlo.percentiles,
          nTrials: result.monteCarlo.nTrials,
        }
      : null,
    warnings: result.warnings,
    layers: layerResults.map((r, i) => ({
      layer: i + 1,
      attachment: r.attachment,
      limit: r.limit,
      blended: r.blended,
      burningCostRol: r.burningCost?.rol ?? null,
      exposureRol: r.exposureRating?.rol ?? null,
      monteCarloRol: r.monteCarlo?.rol ?? null,
    })),
  };
}

// ── Server hydration (slice contract) ──────────────────────────────────────

/**
 * Merge a loaded server snapshot under the live AppContext slice.
 * Returns the object to `replaceSlice` with, or null when the server
 * had nothing saved (the slice must then be left untouched).
 *
 * Two concerns, preserved exactly from the pre-refactor screen:
 *
 *   1. The Structure page writes layer fields into this same slice
 *      before the user gets here, so a blind replaceSlice would
 *      clobber those edits with the last-saved snapshot. Merge under
 *      existing AppContext: non-empty AppContext fields win, server
 *      fills in the rest.
 *   2. Records saved during early iterations of this branch had layer 0
 *      as top-level attachmentLossRatio / limitLossRatio / epi fields
 *      (no layers array). Migrate to the canonical shape on the way in
 *      so the rest of the screen only sees one shape.
 */
export function mergeLoadedInputs(
  data: Partial<StopLossPricingBundle> | null | undefined,
  currentSlice: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!data || !data.inputs || Object.keys(data.inputs).length === 0) return null;
  const incoming: Record<string, unknown> = { ...data.inputs };
  if (!Array.isArray(incoming.layers) && (incoming.attachmentLossRatio || incoming.limitLossRatio || incoming.epi)) {
    incoming.layers = [{
      attachmentLossRatio: incoming.attachmentLossRatio ?? '',
      limitLossRatio: incoming.limitLossRatio ?? '',
      epi: incoming.epi ?? '',
    }];
  }
  const current = currentSlice || {};
  const merged: Record<string, unknown> = { ...DEFAULT_INPUTS, ...incoming };
  for (const k of Object.keys(current)) {
    const v = current[k];
    const hasValue = v !== undefined
      && v !== null
      && v !== ''
      && !(Array.isArray(v) && v.length === 0);
    if (hasValue) merged[k] = v;
  }
  return merged;
}
