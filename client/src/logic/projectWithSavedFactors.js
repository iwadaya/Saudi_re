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
import { loadLossCategoryByYear } from './lossCategoryAmounts';
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

/** Latest non-null cumulative value per origin year (the actual diagonal). */
function latestPerYear(matrix, years) {
  return years.map((yr, r) => {
    let latest = 0;
    for (let c = (matrix[r]?.length || 0) - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latest = matrix[r][c]; break; }
    }
    return { year: yr, latest };
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
 *   source: 'saved-factors' | 'triangle-recalc' | 'straight-blend' | 'straight-benchmark' | null
 *     Provenance of the LOSS projection. 'saved-factors' means the incurred
 *     (attritional) projection used saved CDFs; saved PREMIUM factors alone
 *     do not qualify — the loss side may still be a triangle recalc.
 *   usedPlaceholderLdfs: true when the projection fell back to the hard-coded
 *     benchmark curves (straightProjections.js) — i.e. no saved factors, no
 *     triangle, and no saved LDF blend. Lets the UI warn that figures rest on
 *     placeholder data.
 */
export async function loadProjectedRows(contractId, opts) {
  if (!contractId) return { rows: [], source: null, usedPlaceholderLdfs: false };

  // Projection philosophy: dev factors are calibrated on the attritional (stripped)
  // triangle. They must be applied to the stripped triangle only. Large loss and CAT
  // amounts are added back explicitly after projection — never projected via the
  // attritional CDF, since those factors carry no information about large/CAT development.

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

    // 2) Load saved dev factors (INCURRED, PAID, PREMIUM), the stripped
    //    (attritional) incurred triangle and the per-treaty strip flag — all
    //    keyed on contractId, fetched together.
    const [incFactorsRes, paidFactorsRes, premFactorsRes, incExclRes, contract] = await Promise.all([
      api.getDevFactors(contractId, 'INCURRED', opts).catch(() => []),
      api.getDevFactors(contractId, 'CLAIMS_PAID', opts).catch(() => []),
      api.getDevFactors(contractId, 'PREMIUM', opts).catch(() => []),
      api.getTriangleWithExclusions(contractId, 'INCURRED', opts).catch(() => null),
      api.getContract(contractId, opts).catch(() => ({})),
    ]);
    const incFactors = incFactorsRes?.factors || (Array.isArray(incFactorsRes) ? incFactorsRes : []);
    const paidFactors = paidFactorsRes?.factors || (Array.isArray(paidFactorsRes) ? paidFactorsRes : []);
    const premFactors = premFactorsRes?.factors || (Array.isArray(premFactorsRes) ? premFactorsRes : []);

    // If no INCURRED factors, fall back to CLAIMS_PAID for the incurred projection
    const effectiveIncFactors = incFactors.length > 0 ? incFactors : paidFactors;

    const savedIncCdfs = buildCdfsFromSaved(effectiveIncFactors);
    const savedPaidCdfs = buildCdfsFromSaved(paidFactors);
    const savedPremCdfs = buildCdfsFromSaved(premFactors);

    // Large/CAT loadings, added back unprojected after the attritional projection.
    // When stripping is off the server returns the full triangle as `stripped`
    // and the loadings are nil, so the result collapses to the plain full
    // projection (back-compatible).
    const stripLC = (contract?.detail?.strip_large_cat_losses ?? false) !== false;
    const lossCat = stripLC
      ? await loadLossCategoryByYear(contractId, opts).catch(() => ({ large: new Map(), cat: new Map() }))
      : { large: new Map(), cat: new Map() };

    // Attritional projection base: the STRIPPED incurred triangle (large/CAT
    // removed). The saved INCURRED dev factors are calibrated on this basis in
    // DevFactorsScreen, so they must be applied here — not to the full paid+OS
    // triangle. Falls back to the full incurred matrix if the stripped triangle
    // is unavailable. Column index aligns with `im` because stripping reduces
    // cell values but never drops (origin_year, dev_months) keys.
    const strippedObj = buildMatrixFromCells(crd(incExclRes?.stripped?.cells || []));
    const imStripped = strippedObj
      ? yrs.map(y => { const r = []; for (let c = 0; c < mc; c++) r.push(gv(strippedObj, y, c)); return r; })
      : im;

    // Paid-only matrix (no OS) — used to project the paid ultimate
    // for the under/over reserving comparison on the projected summary.
    const paidM = yrs.map(y => {
      const r = [];
      for (let c = 0; c < mc; c++) r.push(gv(pdo, y, c));
      return r;
    });

    let attrProj = [], paidProj = [], premProj = [], source = 'triangle-recalc';

    // Project the ATTRITIONAL incurred from the stripped triangle — prefer the
    // underwriter's saved factors. Large/CAT are not projected here; they are
    // added back unprojected when assembling the rows below.
    if (savedIncCdfs) {
      attrProj = projectWithCdfs(imStripped, yrs, savedIncCdfs);
      source = 'saved-factors';
    } else {
      try {
        const cdfs = recalcCdfs(imStripped);
        attrProj = projectWithCdfs(imStripped, yrs, cdfs);
      } catch (e) { attrProj = []; }
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

    // Project premiums — prefer saved factors. Note: `source` reports the
    // provenance of the LOSS projection only (set above); saved PREMIUM
    // factors alone must not report 'saved-factors' while the loss numbers
    // came from a triangle recalculation.
    if (savedPremCdfs) {
      premProj = projectWithCdfs(pm, yrs, savedPremCdfs);
    } else {
      try {
        const cdfs = recalcCdfs(pm);
        premProj = projectWithCdfs(pm, yrs, cdfs);
      } catch (e) { premProj = []; }
    }

    // Actual (latest) incurred is the raw FULL paid+OS diagonal — large/CAT are
    // part of the realised experience and are only stripped for the projection.
    const fullLatest = latestPerYear(im, yrs);

    const rows = yrs.map(y => {
      const pP = premProj.find(p => p.year === y);
      const aP = attrProj.find(p => p.year === y);
      const dP = paidProj.find(p => p.year === y);
      const fl = fullLatest.find(p => p.year === y);
      // Only add large/CAT back when we actually projected the STRIPPED
      // (attritional) triangle. If the stripped fetch failed, imStripped fell
      // back to the full triangle — large/CAT are already in the projection, so
      // adding them again would double-count.
      const large = (stripLC && strippedObj) ? (lossCat.large.get(Number(y)) || 0) : 0;
      const cat = (stripLC && strippedObj) ? (lossCat.cat.get(Number(y)) || 0) : 0;
      // Total projected incurred = attritional projected ultimate + large loss
      // loading + CAT loading. deriveLossComponents downstream subtracts the
      // same large/CAT back out to recover the attritional component, so this
      // value must remain the full incurred total.
      const ultLoss = (aP?.ultimate || 0) + large + cat;
      return {
        year: y,
        ultPrem: pP?.ultimate || 0,
        ultLoss,
        ultPaid: dP?.ultimate || 0,
        ultIncurred: ultLoss,
        actPrem: pP?.latest || 0,
        actLoss: fl?.latest || 0,
        actPaid: dP?.latest || 0,
      };
    });

    if (rows.length > 0) return { rows, source, usedPlaceholderLdfs: false };
  }

  // 3) Fallback: straight stats (no-triangulation)
  const ssData = await api.getStraightStats(contractId, opts).catch(() => null);
  const stats = ssData?.stats || [];
  if (stats.length === 0) return { rows: [], source: null, usedPlaceholderLdfs: false };

  const parsed = stats.map(s => ({
    year: Number(s.underwriting_year || s.year),
    premium: cn(s.premium),
    paid: cn(s.paid_claims || s.paid),
    os: cn(s.os_claims || s.os),
  }));

  // No-triangulation stripping is straightforward: remove the year's large/cat
  // losses from its incurred, project the remaining attritional with the same
  // loss dev factor, then add large/cat back unprojected — so downstream
  // Incurred = attritional + large + cat. Honours the per-treaty strip flag
  // (default off). Actual incurred (actLoss) is left raw.
  const contract = await api.getContract(contractId, opts).catch(() => ({}));
  const stripLC = (contract?.detail?.strip_large_cat_losses ?? false) !== false;
  const lossCat = stripLC
    ? await loadLossCategoryByYear(contractId, opts).catch(() => ({ large: new Map(), cat: new Map() }))
    : null;
  const applyStrip = (projRows) => {
    if (!stripLC || !lossCat) return projRows;
    return projRows.map(r => {
      const large = lossCat.large.get(Number(r.year)) || 0;
      const cat = lossCat.cat.get(Number(r.year)) || 0;
      if (large + cat <= 0) return r;
      const incurred = r.actLoss || 0;
      const cdf = Number.isFinite(r.devFactor) && r.devFactor > 0
        ? r.devFactor
        : (incurred > 0 ? (r.ultLoss || 0) / incurred : 1);
      const ultAttritional = Math.max(0, incurred - large - cat) * cdf;
      return { ...r, ultLoss: ultAttritional + large + cat };
    });
  };

  // 3a) Preferred: project against the underwriter's saved per-class
  // blend (the LDF Analysis modal writes here). Tail type is just a
  // marker — the curve itself lives in contract_ldf_blend_curve.
  const blendRows = await projectFromSavedBlend(contractId, parsed, opts);
  if (blendRows) return { rows: applyStrip(blendRows), source: 'straight-blend', usedPlaceholderLdfs: false };

  // 3b) Last resort: hard-coded benchmark curve, picked by the contract's
  // primary class of business (falls through to DEFAULT_LDF_KEY when the
  // class can't be resolved). Used only for treaties that haven't yet
  // saved an LDF blend.
  const { projectStraightStats, DEFAULT_LDF_KEY } = await import('./straightProjections');
  const classKey = ssData?.primary_class_key || DEFAULT_LDF_KEY;
  const rows = projectStraightStats(parsed, classKey);
  // Hard-coded benchmark/placeholder curves — flag so the UI can warn.
  return { rows: applyStrip(rows), source: 'straight-benchmark', usedPlaceholderLdfs: true };
}

// ── Saved-blend projection ───────────────────────────────────────────────
//
// Pulls the underwriter-chosen LDF blend for PREMIUM and CLAIMS_PAID
// and projects each row chain-ladder style: the newest year (age 12)
// gets the dev_month-12 CDF (the largest — the full LDF product), each
// older year the CDF for its age, and years beyond the curve the ≈1.0
// tail. Returns null when no blend has been saved for either triangle
// type (caller falls back to the hard-coded curves).

function blendCurveToCdfArray(blended) {
  if (!Array.isArray(blended) || blended.length === 0) return null;
  // contract_ldf_blend_curve stores one CDF per dev_month; the server
  // accumulates the LDF product back-to-front, so the dev_month-12 row
  // carries the full product (the LARGEST CDF) and the last dev_month is
  // the ≈1.0 tail. Sorted ascending by dev_month, the array therefore
  // reads cdfs[0] = factor for age 12 (newest, least-developed year),
  // cdfs[last] = factor for the most-developed age — the same
  // age-indexed convention as chainLadder.calculateCdfs.
  const sorted = [...blended].sort((a, b) => Number(a.devMonth) - Number(b.devMonth));
  return sorted.map(p => Number(p.cdf));
}

async function projectFromSavedBlend(contractId, parsed, opts) {
  const [prem, claims] = await Promise.all([
    api.getLdfBlend(contractId, 'PREMIUM', opts).catch(() => null),
    api.getLdfBlend(contractId, 'CLAIMS_PAID', opts).catch(() => null),
  ]);
  const premCdfs   = blendCurveToCdfArray(prem?.blended);
  const claimsCdfs = blendCurveToCdfArray(claims?.blended);
  if (!premCdfs && !claimsCdfs) return null;

  const n = parsed.length;
  const sorted = [...parsed].sort((a, b) => a.year - b.year);
  const pickCdf = (cdfs, devIdx) => {
    if (!cdfs || cdfs.length === 0) return 1.0;
    // devIdx counts years since the newest (0 = newest year, age 12).
    // The blend CDF array is age-indexed the same way (cdfs[0] = the
    // dev_month-12 factor, the largest — see blendCurveToCdfArray), so
    // devIdx indexes it directly. Years older than the curve extends are
    // treated as fully developed: clamp to the last (≈1.0 tail) entry.
    if (devIdx >= cdfs.length) return cdfs[cdfs.length - 1];
    return cdfs[devIdx];
  };

  return sorted.map((row, i) => {
    const devIdx  = n - 1 - i;
    const lossCDF = pickCdf(claimsCdfs, devIdx);
    const premCDF = pickCdf(premCdfs, devIdx);
    const prem = parseFloat(row.premium) || 0;
    const paid = parseFloat(row.paid)    || 0;
    const os   = parseFloat(row.os)      || 0;
    const incurred = paid + os;
    return {
      year:          Number(row.year),
      actPrem:       prem,
      actLoss:       incurred,
      ultPrem:       prem * premCDF,
      ultLoss:       incurred * lossCDF,
      devFactor:     lossCDF,
      premDevFactor: premCDF,
    };
  });
}
