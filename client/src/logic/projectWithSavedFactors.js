/**
 * projectWithSavedFactors.js
 *
 * Projects triangle data to ultimate using the underwriter's SAVED development
 * factors from the Dev Factors screen, rather than recalculating fresh from the
 * raw triangle cells.
 *
 * Priority chain:
 *   1. Saved chosen_ldf/chosen_cdf from contract_dev_factor (underwriter selected)
 *   2. Fallback: recalculate from raw triangle using weighted average (no exclusions)
 *
 * This ensures the Quick Summary and Projected Summary screens honour the
 * underwriter's factor selections, including outlier exclusions, parametric
 * overrides, and manual edits.
 */

import { api } from '../api';
import { toN as cn } from '../utils/format';
import {
  buildMatrixFromCells, calculateAgeToAgeFactors, calculatePattern, calculateCdfs,
} from './chainLadder';
function crd(data) {
  const rows = Array.isArray(data) ? data : (data?.cells || []);
  return rows.map(r => ({
    origin_year: Number(r.origin_year),
    dev_months: Number(r.dev_months),
    cum_value: r.cum_value == null || r.cum_value === '' ? null : cn(r.cum_value),
  }));
}

/**
 * Build CDFs array from saved dev factors.
 * The saved factors have chosen_cdf at each dev_month (12, 24, 36, ...).
 * Returns null if no saved factors found.
 */
function buildCdfsFromSaved(savedFactors) {
  if (!Array.isArray(savedFactors) || savedFactors.length === 0) return null;
  const sorted = [...savedFactors].sort((a, b) => (a.dev_month || 0) - (b.dev_month || 0));
  const cdfs = sorted.map(f => {
    const v = f.chosen_cdf ?? f.selected_cdf ?? null;
    return v != null ? Number(v) : null;
  });
  // If any CDF is null, the saved factors are incomplete — fall back
  if (cdfs.some(v => v == null || !Number.isFinite(v))) return null;
  return cdfs;
}

/**
 * Project a single matrix using provided CDFs.
 * Returns [{year, latest, cdf, ultimate, ibnr}] for each origin year.
 */
function projectWithCdfs(matrix, years, cdfs) {
  return years.map((yr, r) => {
    let latestVal = 0, latestCol = -1;
    for (let c = (matrix[r]?.length || 0) - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latestVal = matrix[r][c]; latestCol = c; break; }
    }
    if (latestCol === -1) return { year: yr, latest: 0, cdf: 1, ultimate: 0, ibnr: 0 };
    const cdf = (latestCol < cdfs.length ? cdfs[latestCol] : 1.0) || 1.0;
    const ultimate = latestVal * cdf;
    return { year: yr, latest: latestVal, cdf, ultimate, ibnr: ultimate - latestVal };
  });
}

/**
 * Fallback: recalculate CDFs from raw triangle matrix using weighted average.
 */
function recalcCdfs(matrix) {
  const factors = calculateAgeToAgeFactors(matrix);
  const { pattern } = calculatePattern(matrix, factors, 'weighted');
  const cdfs = calculateCdfs(pattern, 1.0);
  return Array.isArray(cdfs) ? cdfs : [];
}

/**
 * Main entry point — loads triangles + saved factors, returns standardRows.
 *
 * @param {string} contractId
 * @param {object} [opts] — passes through to api.* (e.g. {quote: true}
 *   so a screen running in quote mode reads from the quote-side
 *   triangles + dev factors instead of the live contract tables).
 * @returns {Promise<{rows: Array, source: string}>}
 *   rows: [{year, ultPrem, ultLoss, actPrem, actLoss}]
 *   source: 'saved-factors' | 'triangle-recalc' | 'straight-short' | 'straight-long' | null
 */
export async function loadProjectedRows(contractId, opts) {
  if (!contractId) return { rows: [], source: null };

  // 1) Load all triangles in parallel
  const [premRes, paidRes, osRes] = await Promise.all([
    api.getTriangle(contractId, 'PREMIUM', opts).catch(() => ({ cells: [] })),
    api.getTriangle(contractId, 'CLAIMS_PAID', opts).catch(() => ({ cells: [] })),
    api.getTriangle(contractId, 'CLAIMS_OS', opts).catch(() => ({ cells: [] })),
  ]);

  const po = buildMatrixFromCells(crd(premRes));
  const pdo = buildMatrixFromCells(crd(paidRes));
  const oso = buildMatrixFromCells(crd(osRes));

  if (po || pdo || oso) {
    // Build unified year list and matrices
    const allYears = new Set([...(po?.years || []), ...(pdo?.years || []), ...(oso?.years || [])]);
    const yrs = Array.from(allYears).sort((a, b) => a - b);
    let mc = 0;
    [po, pdo, oso].filter(Boolean).forEach(o => (o.matrix || []).forEach(r => { mc = Math.max(mc, r.length); }));
    if (!mc) mc = 1;

    const gv = (o, y, c) => {
      if (!o) return null;
      const i = o.years.indexOf(y);
      return i === -1 ? null : o.matrix[i]?.[c] ?? null;
    };

    // Incurred matrix = paid + OS
    const im = yrs.map(y => {
      const r = [];
      for (let c = 0; c < mc; c++) {
        const p = gv(pdo, y, c), o = gv(oso, y, c);
        r.push(p === null && o === null ? null : (p || 0) + (o || 0));
      }
      return r;
    });

    // Premium matrix
    const pm = yrs.map(y => {
      const r = [];
      for (let c = 0; c < mc; c++) r.push(gv(po, y, c));
      return r;
    });

    // 2) Try to load saved dev factors for INCURRED, PAID, and PREMIUM
    const [incFactorsRes, paidFactorsRes, premFactorsRes] = await Promise.all([
      api.getDevFactors(contractId, 'INCURRED', opts).catch(() => []),
      api.getDevFactors(contractId, 'CLAIMS_PAID', opts).catch(() => []),
      api.getDevFactors(contractId, 'PREMIUM', opts).catch(() => []),
    ]);
    const incFactors = incFactorsRes?.factors || (Array.isArray(incFactorsRes) ? incFactorsRes : []);
    const paidFactors = paidFactorsRes?.factors || (Array.isArray(paidFactorsRes) ? paidFactorsRes : []);
    const premFactors = premFactorsRes?.factors || (Array.isArray(premFactorsRes) ? premFactorsRes : []);

    // If no INCURRED factors, fall back to CLAIMS_PAID for the incurred projection
    const effectiveIncFactors = incFactors.length > 0 ? incFactors : paidFactors;

    const savedIncCdfs = buildCdfsFromSaved(effectiveIncFactors);
    const savedPaidCdfs = buildCdfsFromSaved(paidFactors);
    const savedPremCdfs = buildCdfsFromSaved(premFactors);

    // Paid-only matrix (no OS) — used to project the paid ultimate
    // for the under/over reserving comparison on the projected summary.
    const paidM = yrs.map(y => {
      const r = [];
      for (let c = 0; c < mc; c++) r.push(gv(pdo, y, c));
      return r;
    });

    let lossProj = [], paidProj = [], premProj = [], source = 'triangle-recalc';

    // Project losses — prefer saved factors
    if (savedIncCdfs) {
      lossProj = projectWithCdfs(im, yrs, savedIncCdfs);
      source = 'saved-factors';
    } else {
      try {
        const cdfs = recalcCdfs(im);
        lossProj = projectWithCdfs(im, yrs, cdfs);
      } catch (e) { lossProj = []; }
    }

    // Project paid (used for under/over reserving comparison)
    if (savedPaidCdfs) {
      paidProj = projectWithCdfs(paidM, yrs, savedPaidCdfs);
    } else {
      try {
        const cdfs = recalcCdfs(paidM);
        paidProj = projectWithCdfs(paidM, yrs, cdfs);
      } catch (e) { paidProj = []; }
    }

    // Project premiums — prefer saved factors
    if (savedPremCdfs) {
      premProj = projectWithCdfs(pm, yrs, savedPremCdfs);
      if (source !== 'saved-factors') source = 'saved-factors';
    } else {
      try {
        const cdfs = recalcCdfs(pm);
        premProj = projectWithCdfs(pm, yrs, cdfs);
      } catch (e) { premProj = []; }
    }

    const rows = yrs.map(y => {
      const pP = premProj.find(p => p.year === y);
      const lP = lossProj.find(p => p.year === y);
      const dP = paidProj.find(p => p.year === y);
      return {
        year: y,
        ultPrem: pP?.ultimate || 0,
        ultLoss: lP?.ultimate || 0,
        ultPaid: dP?.ultimate || 0,
        ultIncurred: lP?.ultimate || 0,
        actPrem: pP?.latest || 0,
        actLoss: lP?.latest || 0,
        actPaid: dP?.latest || 0,
      };
    });

    if (rows.length > 0) return { rows, source };
  }

  // 3) Fallback: straight stats (no-triangulation)
  const { projectStraightStats } = await import('./straightProjections');
  const ssData = await api.getStraightStats(contractId, opts).catch(() => null);
  const stats = ssData?.stats || [];
  const tailType = ssData?.tail_type || 'SHORT_TAIL';

  if (stats.length > 0) {
    const parsed = stats.map(s => ({
      year: Number(s.underwriting_year || s.year),
      premium: cn(s.premium),
      paid: cn(s.paid_claims || s.paid),
      os: cn(s.os_claims || s.os),
    }));
    const rows = projectStraightStats(parsed, tailType);
    return { rows, source: tailType === 'LONG_TAIL' ? 'straight-long' : 'straight-short' };
  }

  return { rows: [], source: null };
}
