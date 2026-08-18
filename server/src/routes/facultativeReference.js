// server/src/routes/facultativeReference.js
// Read-only reference data for the facultative pricing workflow.
// Backed by tables seeded in migrations 077 + 078. Mounted under
// /api as /fac/reference/* — same convention as routes/facultative.js.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { listFamilies, RATING_BASIS_LABEL, SEGMENT_LABEL } from '../../../shared/fac/index.js';

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
      error: 'Authentication required.',
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

// The rating-family registry. Served from shared/fac rather than the
// database because a family is code (an engine and its rules), not data —
// the class → family mapping is the data, and it lives on
// fac_class_of_business. The screen uses this to tell an underwriter what a
// class rates on and whether its engine exists yet, instead of running a
// marine risk into the property engine and rendering the exception.
router.get('/fac/reference/families', (_req, res) => {
  res.set('Cache-Control', CACHE_HEADER);
  res.json({
    families: listFamilies().map((f) => ({
      code: f.code,
      label: f.label,
      segment: f.segment,
      segment_label: SEGMENT_LABEL[f.segment] || f.segment,
      rating_basis: f.ratingBasis,
      rating_basis_label: RATING_BASIS_LABEL[f.ratingBasis] || f.ratingBasis,
      period_basis: f.periodBasis,
      methods: f.methods,
      requires: f.requires || [],
      wizard_steps: f.wizardSteps || [],
      implemented: f.implemented,
      planned_phase: f.plannedPhase || null,
      notes: f.notes || null,
    })),
  });
});

// Which reference set is in force. A priced row stores this label so
// re-opening it after a rate revision can say which rates produced the
// number, instead of silently recomputing against today's (finding F12).
router.get('/fac/reference/rate-version', asyncHandler(async (req, res) => {
  const asOf = typeof req.query.asOf === 'string' && req.query.asOf ? req.query.asOf : null;
  const { rows } = await pool.query(
    `SELECT version_label, effective_from, effective_to, notes
       FROM public.fac_rate_table_version
      WHERE effective_from <= COALESCE($1::date, CURRENT_DATE)
        AND (effective_to IS NULL OR effective_to >= COALESCE($1::date, CURRENT_DATE))
      ORDER BY effective_from DESC
      LIMIT 1`,
    [asOf],
  );
  // No cache header: the active version is the one thing here that can
  // change without a deploy.
  res.json(rows[0] || null);
}));

// The exposure-curve library and the size bands each family rates through.
//
// One curve ships as data — G(x) = x, the uniform destruction rate, which
// asserts nothing about severity. Every other curve encodes a view of how
// severe losses are for a kind of risk, and that view belongs to whoever
// holds the data behind it, so curve sets are loaded rather than invented
// here. See docs/facultative-pricing-design.md §8.
router.get('/fac/reference/curves', asyncHandler(async (req, res) => {
  const family = typeof req.query.family === 'string' ? req.query.family : null;
  const [curves, bands] = await Promise.all([
    pool.query(
      `SELECT curve_id, curve_code, curve_name, curve_set, source, kind, params,
              effective_from, effective_to, active, notes
         FROM public.fac_exposure_curve
        WHERE active = true
        ORDER BY curve_set NULLS LAST, curve_code`,
    ),
    pool.query(
      `SELECT b.band_id, b.family_code, b.min_exposure, b.max_exposure,
              c.curve_code, c.curve_name
         FROM public.fac_curve_band b
         JOIN public.fac_exposure_curve c ON c.curve_id = b.curve_id
        WHERE ($1::text IS NULL OR b.family_code = $1)
        ORDER BY b.family_code, b.min_exposure`,
      [family],
    ),
  ]);
  res.set('Cache-Control', CACHE_HEADER);
  res.json({ curves: curves.rows, bands: bands.rows });
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
