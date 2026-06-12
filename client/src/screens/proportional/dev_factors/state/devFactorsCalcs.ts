// state/devFactorsCalcs.ts — pure domain helpers, constants and types for
// the Dev Factors screen (Phase 4.2 decomposition of DevFactorsScreen.jsx).
//
// Everything here is a VERBATIM move from the pre-refactor screen: the
// route→type maps, the 4dp/percent formatters shared by every factor table,
// and buildCalcs — the full chain-ladder bundle (matrix → age-to-age factors
// → averaged pattern → CDFs → exponential fit → per-year projections) that
// runs once per basis (displayed / full / stripped). The observable numbers
// are pinned literal-by-literal in goldenMaster.test.jsx — do not "fix"
// rounding or averaging here without updating that contract deliberately.

import {
  buildMatrixFromCells, calculateAgeToAgeFactors, calculatePattern,
  calculateCdfs, fitExponentialCdfs, deriveLdfsFromCdfs,
} from '../../../../logic/chainLadder';
import type { TriangleCell } from '../../../../types/pricing';

export type DevFactorsView = 'DEV_FACTORS' | 'LINK_RATIOS' | 'GRAPH';
export type TriangleBasis = 'FULL' | 'STRIPPED';
export type ProjMethod = 'CHAIN' | 'BF';
export type AvgMethod = 'weighted' | 'simple' | 'last3' | 'last5';
export type ChosenBase = 'ACTUAL' | 'PARAM' | 'LINK_RATIO';

/** One editable factor cell — saved rows can carry DB numerics as strings. */
export type FactorValue = number | string | null;

export interface ExclusionsSummary {
  largeLossCount: number;
  catLossCount: number;
  applies: boolean;
  proxyPlaced: number;
}

export const ZERO_EXCLUSIONS: ExclusionsSummary = Object.freeze({
  largeLossCount: 0, catLossCount: 0, applies: false, proxyPlaced: 0,
});

export type Matrix = Array<Array<number | null>>;

export interface ClProjectionRow {
  year: number;
  latest: number;
  cdf: number;
  ultimate: number;
  ibnr: number;
}

export interface PatternWarning {
  column: number;
  devPeriod: string;
  contributingRows: number;
  message: string;
}

/** The full chain-ladder calculation bundle for one triangle basis. */
export interface CalcBundle {
  matrix: Matrix;
  factors: Array<Array<number | null>>;
  pattern: number[];
  patternWarnings: PatternWarning[];
  cdfs: number[];
  paramLdfs: Array<number | null>;
  paramCdfs: number[];
  clProjections: ClProjectionRow[];
}

export type TriCellsByType = Record<string, TriangleCell[]>;

export const TYPE_MAP: Record<string, string> = {
  PROP_PREMIUM_DEV_FACTORS: 'PREMIUM',
  PROP_PAID_CLAIMS_DEV_FACTORS: 'CLAIMS_PAID',
  PROP_OS_CLAIMS_DEV_FACTORS: 'CLAIMS_OS',
  PROP_INCURRED_DEV_FACTORS: 'INCURRED',
};

export const TRIANGLE_SOURCE: Record<string, string[]> = {
  PROP_PREMIUM_DEV_FACTORS: ['PREMIUM'],
  PROP_PAID_CLAIMS_DEV_FACTORS: ['CLAIMS_PAID'],
  PROP_OS_CLAIMS_DEV_FACTORS: ['CLAIMS_OS'],
  // Incurred is served as a single combined type — the server builds the full
  // (paid + OS) triangle and strips the incurred amount directly from it. See
  // combineIncurredCells in server/src/lib/triangleStripping.js.
  PROP_INCURRED_DEV_FACTORS: ['INCURRED'],
};

export const AVG_METHOD_LABEL: Record<string, string> = {
  weighted: 'Weighted', simple: 'Simple', last3: 'Last 3', last5: 'Last 5',
};

// `fullLdfs`/`fullCdfs` reference rows: amber-flag any selected LDF that
// exceeds its full-basis counterpart by more than this epsilon.
export const OVER_FULL_EPS = 1e-4;

export const fmt4 = (n: unknown): string =>
  (n == null || !Number.isFinite(Number(n))) ? '' : Number(n).toFixed(4);

export const fmtPct = (n: unknown): string =>
  (n == null || !Number.isFinite(Number(n))) ? '' : (Number(n) * 100).toFixed(1) + '%';

export function sameNumberArray(a: ReadonlyArray<unknown> = [], b: ReadonlyArray<unknown> = []): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export function serializeChosenSource(source: ChosenBase): string {
  return source === 'LINK_RATIO' ? 'SELECTED' : source;
}

/** Comma-tolerant numeric parse for the EPI input cells. */
export function parseNum(v: unknown): number {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export interface BuildCalcsParams {
  triSources: string[];
  startYear: number | null;
  numDevYears: number;
  avgMethod: AvgMethod;
  years: number[];
  excluded: Set<string>;
}

/* Build the full chain-ladder calc bundle (matrix → factors → pattern →
   cdfs → projections) from a {type: cells[]} map. Pulled out of the
   component so it can run once for the displayed basis and once for the
   full (unstripped) basis that feeds the conservative reference column. */
export function buildCalcs(
  triCells: TriCellsByType,
  { triSources, startYear, numDevYears, avgMethod, years, excluded }: BuildCalcsParams,
): CalcBundle | null {
  // Every screen now has a single triangle source — including Incurred, which
  // the server returns as a combined (paid + OS) triangle already stripped of
  // the incurred loss amount when applicable.
  const d = buildMatrixFromCells(triCells[triSources[0]] || [], startYear, numDevYears);
  if (!d) return null;
  const matrix: Matrix = d.matrix;
  const factors = calculateAgeToAgeFactors(matrix);
  const { pattern, warnings: patternWarnings } = calculatePattern(matrix, factors, avgMethod, { excluded });
  const cdfs: number[] = calculateCdfs(pattern, 1.0);
  const paramCdfs: number[] = fitExponentialCdfs(cdfs);
  const paramLdfs: Array<number | null> = deriveLdfsFromCdfs(paramCdfs);
  const clProjections: ClProjectionRow[] = years.map((yr, r) => {
    let latestVal = 0, latestCol = -1;
    for (let c = matrix[r].length - 1; c >= 0; c--) if (matrix[r][c] != null) { latestVal = matrix[r][c] as number; latestCol = c; break; }
    const cdf = latestCol >= 0 ? (cdfs[latestCol] || 1.0) : 1.0;
    return { year: yr, latest: latestVal, cdf, ultimate: latestVal * cdf, ibnr: latestVal * cdf - latestVal };
  });
  return { matrix, factors, pattern, patternWarnings, cdfs, paramLdfs, paramCdfs, clProjections };
}
