// server/src/routes/facultativeReference.js
// Read-only reference data for the facultative pricing workflow.
// Backed by tables seeded in migrations 077 + 078. Mounted under
// /api as /fac/reference/* — same convention as routes/facultative.js.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';

const router = Router();

// Five-minute private cache. Reference data changes only via migration,
// so even an aggressive value is safe and slashes a noisy chatter pattern
// when the wizard navigates between screens.
const CACHE_HEADER = 'private, max-age=300';

// Router-level guard: every endpoint here needs an authenticated user.
// The global attachRequestContext middleware reads x-user-id into
// req.user.userId; we surface a 401 instead of leaking reference data
// to anonymous callers.
function requireUserId(req, res, next) {
  if (!req.user?.userId) {
    return res.status(401).json({
      error: 'Unauthorised: missing x-user-id header.',
      code: 'UNAUTHORIZED',
    });
  }
  next();
}

router.use('/fac/reference', requireUserId);

router.get('/fac/reference/occupancies', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT occupancy_code, occupancy_name, industry_type,
           hazard_grade, hazard_category, risk_category, frequency_category,
           flexa_rate, flexa_base_rate_pm, sort_order
      FROM public.fac_occupancy_master
     WHERE active = true
     ORDER BY occupancy_name
  `);
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ occupancies: rows });
}));

router.get('/fac/reference/factors', asyncHandler(async (_req, res) => {
  const { rows: factors } = await pool.query(`
    SELECT factor_code, factor_name, sort_order, affects_rate, affects_score
      FROM public.fac_factor_master
     ORDER BY sort_order
  `);
  const { rows: options } = await pool.query(`
    SELECT option_id, factor_code, option_label, score, discount_loading, sort_order
      FROM public.fac_factor_option
     ORDER BY factor_code, sort_order
  `);
  const optionsByCode = new Map();
  for (const opt of options) {
    if (!optionsByCode.has(opt.factor_code)) optionsByCode.set(opt.factor_code, []);
    optionsByCode.get(opt.factor_code).push(opt);
  }
  const enriched = factors.map((f) => ({
    ...f,
    options: optionsByCode.get(f.factor_code) || [],
  }));
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ factors: enriched });
}));

router.get('/fac/reference/factor-weights', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT scheme, factor_code, weight
      FROM public.fac_factor_weight
     ORDER BY scheme, factor_code
  `);
  const schemes = {};
  for (const r of rows) {
    if (!schemes[r.scheme]) schemes[r.scheme] = {};
    schemes[r.scheme][r.factor_code] = Number(r.weight);
  }
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ schemes });
}));

router.get('/fac/reference/scoring-tables', asyncHandler(async (_req, res) => {
  const [hg, fq, cb, tc] = await Promise.all([
    pool.query(`SELECT hazard_grade, score
                  FROM public.fac_hazard_grade_score
                 ORDER BY hazard_grade`),
    pool.query(`SELECT frequency_category, score
                  FROM public.fac_frequency_score
                 ORDER BY frequency_category`),
    pool.query(`SELECT band_id, score_min, score_max, grade, description,
                       max_capacity_pct, min_tech_rate_pm, underwriting_action
                  FROM public.fac_capacity_band
                 ORDER BY score_min DESC`),
    pool.query(`SELECT region, max_capacity
                  FROM public.fac_territorial_capacity
                 ORDER BY region`),
  ]);
  res.set('Cache-Control', CACHE_HEADER);
  res.json({
    hazard_grade: hg.rows,
    frequency: fq.rows,
    capacity_bands: cb.rows,
    territorial_capacity: tc.rows,
  });
}));

router.get('/fac/reference/bi-indemnity', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT indemnity_months, base_rate_loading
      FROM public.fac_bi_indemnity_loading
     ORDER BY indemnity_months
  `);
  const loadings = {};
  for (const r of rows) loadings[String(r.indemnity_months)] = Number(r.base_rate_loading);
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ loadings });
}));

router.get('/fac/reference/natcat-rates', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT rate_id, country_zone, flood_storm_rate, earthquake_rate, active
      FROM public.fac_natcat_rate
     WHERE active = true
     ORDER BY country_zone
  `);
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ rates: rows });
}));

router.get('/fac/reference/clauses', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT clause_code, clause_name, clause_category, is_mandatory, sort_order
      FROM public.fac_clause_master
     ORDER BY sort_order
  `);
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ clauses: rows });
}));

export default router;
