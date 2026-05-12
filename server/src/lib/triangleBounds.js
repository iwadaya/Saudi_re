// server/src/lib/triangleBounds.js
//
// Server-side defence: ensure only cells inside the upper triangle reach
// contract_triangle_cells / quote_triangle_cells, regardless of how they
// were entered on the client (manual paste, Excel agent import, future
// automation, etc). The client already filters before sending; this is
// the last line of defence.
//
// Triangle shape rule: row r (origin year r years from the start) only
// has actuarial data through dev period (numDevYears - r). So col c is
// valid for row r when c <= numDevYears - r - 1, i.e.:
//
//     (origin_year - startYear) + (dev_months / 12 - 1) < numDevYears

import { pool } from '../db/pool.js';
import { logger } from './logger.js';

/**
 * Look up the triangle bounds for a contract or quote. Returns null if
 * the contract/quote doesn't exist or doesn't have enough metadata to
 * compute the bounds — callers should treat null as "be permissive".
 *
 * @param {'treaty'|'quote'} kind
 * @param {string} id
 * @returns {Promise<{ startYear:number, numDevYears:number } | null>}
 */
export async function getTriangleBounds(kind, id) {
  const isQuote = kind === 'quote';
  const tbl = isQuote ? 'quote' : 'contract';
  const idCol = isQuote ? 'quote_id' : 'contract_id';
  const ppd = isQuote ? 'quote_prop_details' : 'contract_prop_details';
  const npd = isQuote ? 'quote_np_details' : 'contract_np_details';

  // Pull the experience-start-year from whichever details row exists +
  // inception year from the entity itself (or, on the contract side,
  // from prop details which also carries inception_date). Mirrors the
  // client's triangleMeta computation in PropTreatyDetail.
  const sql = `
    SELECT
      COALESCE(npd.experience_start_year, ppd.experience_start_year)::int AS exp_start,
      EXTRACT(YEAR FROM COALESCE(c.inception_date${isQuote ? '' : ', ppd.inception_date'}))::int AS inception_year
    FROM public.${tbl} c
    LEFT JOIN public.${ppd} ppd ON ppd.${idCol} = c.${idCol}
    LEFT JOIN public.${npd} npd ON npd.${idCol} = c.${idCol}
    WHERE c.${idCol} = $1
  `;
  let rows;
  try {
    ({ rows } = await pool.query(sql, [id]));
  } catch (err) {
    // Schema drift or permissions issue — fall back to permissive but
    // surface it: a silent fall-through means the triangle save loses
    // its server-side bounds defence and any cells the client failed
    // to filter slip into the DB.
    logger.warn('[triangleBounds] lookup failed; falling back to permissive', {
      kind, id, error: err.message,
    });
    return null;
  }
  if (!rows.length) {
    logger.warn('[triangleBounds] no entity row; falling back to permissive', { kind, id });
    return null;
  }

  const inceptionYear = Number(rows[0].inception_year);
  if (!Number.isFinite(inceptionYear)) {
    logger.warn('[triangleBounds] no inception_year; falling back to permissive', { kind, id });
    return null;
  }

  const expStart = Number(rows[0].exp_start);
  // Match the client default: when the user hasn't set an explicit
  // experience start year, walk back 10 years from inception.
  const startYear = Number.isFinite(expStart) ? expStart : (inceptionYear - 10);

  const numDevYears = Math.max(1, Math.min(60, inceptionYear - startYear));
  return { startYear, numDevYears };
}

/**
 * Filter cells to only those inside the upper triangle. Cells where
 * origin_year < startYear or dev_months < 12 are also dropped (they're
 * outside the addressable grid). When bounds is null the input passes
 * through untouched (caller decides whether to reject or accept).
 */
export function filterTriangleCells(bounds, cells) {
  if (!Array.isArray(cells)) return [];
  if (!bounds) return cells;
  const { startYear, numDevYears } = bounds;
  return cells.filter((c) => {
    const oy = Number(c?.origin_year);
    const dm = Number(c?.dev_months);
    if (!Number.isFinite(oy) || !Number.isFinite(dm)) return false;
    const r = oy - startYear;
    const col = Math.round(dm / 12) - 1;
    if (r < 0 || col < 0) return false;
    return col <= numDevYears - r - 1;
  });
}

/**
 * Accept any of the wire shapes the various clients send and return a
 * flat array of { origin_year, dev_months, cum_value } cells. Unknown
 * shapes return [].
 *
 *  - body is an array              → use as-is
 *  - body.cells is an array        → use that (TriangleScreen)
 *  - body.triangle is { dev_years, rows: [{uw_year, values: [...]}] }
 *      → expand into cells (ExcelImportAgent)
 */
export function normalizeTriangleRequest(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.cells)) return body.cells;
  if (body && body.triangle) {
    const t = body.triangle;
    const out = [];
    const devYears = Array.isArray(t.dev_years) ? t.dev_years : [];
    const rows = Array.isArray(t.rows) ? t.rows : [];
    for (const row of rows) {
      const oy = Number(row?.uw_year);
      if (!Number.isFinite(oy)) continue;
      const values = Array.isArray(row?.values) ? row.values : [];
      values.forEach((v, i) => {
        if (v == null || v === '') return;
        const cv = Number(v);
        if (!Number.isFinite(cv)) return;
        // Accept dev periods given as months (e.g. 12, 24) or as plain
        // integer indices (1, 2, ...) — normalise to months.
        const raw = Number(devYears[i]);
        const dm = Number.isFinite(raw)
          ? (raw < 12 ? raw * 12 : raw)
          : (i + 1) * 12;
        out.push({ origin_year: oy, dev_months: dm, cum_value: cv });
      });
    }
    return out;
  }
  return [];
}
