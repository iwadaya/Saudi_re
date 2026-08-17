// server/src/services/facPricingService.js
//
// The server half of facultative pricing.
//
// Until now the fac engine was client-only: the browser computed every rate,
// premium, score and capacity figure and POSTed the results, and the server
// stored whatever arrived. ENGINE_VERSION was a string constant in a React
// file (finding F13). The non-proportional flow has had a server-side
// recompute and a drift signal for a while (lib/pricingVerifier.js); this is
// the same idea for facultative, built on the same shared math the client
// runs so there is exactly one formula.
//
// Two entry points:
//   computeFacPricing(riskId)  — the authoritative price for a risk.
//   verifyFacPricing(posted, computed) — what the browser sent vs what the
//                                        server derives, for the drift log.
//
// Reference data changes only through migrations, so it is memoised for a
// few minutes rather than re-queried per request.

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { priceFacRisk } from '../../../shared/fac/index.js';

const REFERENCE_TTL_MS = 5 * 60 * 1000;

/** @type {{at: number, data: object}|null} */
let referenceCache = null;

/** Test seam — reference data is memoised per process. */
export function resetFacReferenceCache() {
  referenceCache = null;
}

/**
 * Every reference table the schedule-property engine reads, in the exact
 * shape shared/fac expects. Mirrors what /api/fac/reference/* serves the
 * browser, so client and server feed the same formula the same numbers.
 */
export async function loadFacReferenceData({ force = false } = {}) {
  if (!force && referenceCache && Date.now() - referenceCache.at < REFERENCE_TTL_MS) {
    return referenceCache.data;
  }

  const [occ, factors, options, weights, hazard, frequency, bands, territorial, bi, natcat] =
    await Promise.all([
      pool.query(`SELECT occupancy_code, occupancy_name, hazard_grade, hazard_category,
                         risk_category, frequency_category, flexa_base_rate_pm
                    FROM public.fac_occupancy_master WHERE active = true`),
      pool.query(`SELECT factor_code, factor_name, affects_rate, affects_score
                    FROM public.fac_factor_master ORDER BY sort_order`),
      pool.query(`SELECT option_id, factor_code, option_label, score, discount_loading
                    FROM public.fac_factor_option ORDER BY factor_code, sort_order`),
      pool.query(`SELECT scheme, factor_code, weight FROM public.fac_factor_weight`),
      pool.query(`SELECT hazard_grade, score FROM public.fac_hazard_grade_score`),
      pool.query(`SELECT frequency_category, score FROM public.fac_frequency_score`),
      pool.query(`SELECT score_min, score_max, grade, description, max_capacity_pct,
                         min_tech_rate_pm, underwriting_action
                    FROM public.fac_capacity_band ORDER BY score_min DESC`),
      pool.query(`SELECT region, max_capacity FROM public.fac_territorial_capacity`),
      pool.query(`SELECT indemnity_months, base_rate_loading FROM public.fac_bi_indemnity_loading`),
      pool.query(`SELECT country_zone, flood_storm_rate, earthquake_rate
                    FROM public.fac_natcat_rate WHERE active = true`),
    ]);

  const optionsByCode = new Map();
  for (const o of options.rows) {
    if (!optionsByCode.has(o.factor_code)) optionsByCode.set(o.factor_code, []);
    optionsByCode.get(o.factor_code).push(o);
  }

  const schemes = {};
  for (const w of weights.rows) {
    if (!schemes[w.scheme]) schemes[w.scheme] = {};
    schemes[w.scheme][w.factor_code] = Number(w.weight);
  }

  const biIndemnity = {};
  for (const r of bi.rows) biIndemnity[String(r.indemnity_months)] = Number(r.base_rate_loading);

  const data = {
    occupancies: occ.rows,
    factors: factors.rows.map((f) => ({ ...f, options: optionsByCode.get(f.factor_code) || [] })),
    factorWeights: schemes,
    hazardGradeScore: hazard.rows,
    frequencyScore: frequency.rows,
    capacityBands: bands.rows,
    territorialCapacity: territorial.rows,
    biIndemnity,
    natcatRates: natcat.rows,
  };
  referenceCache = { at: Date.now(), data };
  return data;
}

/**
 * The reference set in force on a given date — the label a priced row is
 * stamped with so re-opening it later can say which rates produced it
 * (finding F12).
 *
 * @param {Date|string|null} [asOf] defaults to today
 * @returns {Promise<string|null>}
 */
export async function getActiveRateTableVersion(asOf = null) {
  const { rows } = await pool.query(
    `SELECT version_label
       FROM public.fac_rate_table_version
      WHERE effective_from <= COALESCE($1::date, CURRENT_DATE)
        AND (effective_to IS NULL OR effective_to >= COALESCE($1::date, CURRENT_DATE))
      ORDER BY effective_from DESC
      LIMIT 1`,
    [asOf || null],
  );
  return rows[0]?.version_label ?? null;
}

/**
 * Price a risk from what is stored: its class (for the rating family), its
 * sections and locations (for the exposure profile), its saved factor
 * selections, and the engine inputs on its pricing row.
 *
 * `overrides` lets a caller price against inputs that have not been saved
 * yet — the pricing screen sends what the underwriter is looking at.
 *
 * @param {string} riskId
 * @param {object} [overrides] engine inputs to use instead of the stored ones
 * @returns {Promise<object>} the priceFacRisk result plus provenance
 */
export async function computeFacPricing(riskId, overrides = {}) {
  const [riskRes, sectionsRes, locationsRes, factorsRes, pricingRes] = await Promise.all([
    pool.query(
      `SELECT r.*, c.rating_family, c.segment_code, c.exposure_basis, c.category
         FROM public.fac_risk r
         LEFT JOIN public.fac_class_of_business c ON c.fac_cob_id = r.fac_cob_id
        WHERE r.fac_risk_id = $1`,
      [riskId],
    ),
    pool.query(
      `SELECT s.*, c.rating_family
         FROM public.fac_risk_section s
         JOIN public.fac_class_of_business c ON c.fac_cob_id = s.fac_cob_id
        WHERE s.fac_risk_id = $1 ORDER BY s.section_no`,
      [riskId],
    ),
    pool.query(
      `SELECT pd_si, bi_si FROM public.fac_location WHERE fac_risk_id = $1`,
      [riskId],
    ),
    pool.query(
      `SELECT selections FROM public.fac_underwriting_factors WHERE fac_risk_id = $1`,
      [riskId],
    ),
    pool.query(
      `SELECT indemnity_months, commission_pct, margin_pct, other_expenses_pct,
              market_rate_pm, extra_cover_loadings
         FROM public.fac_pricing WHERE fac_risk_id = $1`,
      [riskId],
    ),
  ]);

  const risk = riskRes.rows[0];
  if (!risk) {
    const err = new Error('Risk not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const stored = pricingRes.rows[0] || {};
  const referenceData = await loadFacReferenceData();

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const pick = (key, fallback = null) => (
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : (stored[key] ?? fallback)
  );

  const inputs = {
    occupancy_code: risk.occupancy_code,
    country_zone:   risk.risk_country_zone,
    region:         risk.cedant_region,
    factor_selections: overrides.factor_selections || factorsRes.rows[0]?.selections || {},
    indemnity_months:   num(pick('indemnity_months')) ?? 12,
    commission_pct:     num(pick('commission_pct')),
    margin_pct:         num(pick('margin_pct')),
    other_expenses_pct: num(pick('other_expenses_pct')),
    market_rate_pm:     num(pick('market_rate_pm')),
    extra_cover_loadings: pick('extra_cover_loadings', []) || [],
  };

  const priced = priceFacRisk({
    risk,
    cob: { rating_family: risk.rating_family },
    sections: sectionsRes.rows,
    locations: locationsRes.rows,
    inputs,
    referenceData,
  });

  return {
    ...priced,
    rate_table_version: await getActiveRateTableVersion(risk.inception_date),
    inputs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Drift verification
// ────────────────────────────────────────────────────────────────────────────

// Same combined absolute + relative shape lib/pricingVerifier.js uses: the
// absolute term keeps us sane near zero, the relative term at large rates.
const TOLERANCE_ABS = 0.0002;
const TOLERANCE_REL = 0.002;

/** Fields worth flagging — the ones an underwriter signs off on. */
const VERIFIED_FIELDS = [
  ['technical_rate_pm',   'technical_rate_no_natcat_pm'],
  ['total_rate_pm',       'total_rate_pm'],
  ['bi_rate_pm',          'bi_rate_pm'],
  ['net_rate_pm',         'net_rate_pm'],
  ['final_net_rate_pm',   'final_net_rate_pm'],
  ['final_gross_rate_pm', 'final_gross_rate_pm'],
  ['underwriting_score',  'underwriting_score'],
];

function withinTolerance(actual, expected) {
  const diff = Math.abs(actual - expected);
  if (diff <= TOLERANCE_ABS) return true;
  return diff <= Math.abs(expected) * TOLERANCE_REL;
}

/**
 * Compare a client-submitted pricing payload against the server's own
 * computation. Returns one entry per field that disagrees beyond tolerance.
 *
 * Warn-only by default, exactly like the NP verifier: the save completes and
 * the drift is logged and counted. FAC_PRICING_STRICT=1 turns it into a
 * rejection once the drift rate has been observed at zero for a full pricing
 * cycle — never before, or a stale browser tab starts failing saves.
 *
 * @param {object} posted   req.body from PUT /fac/risks/:id/pricing
 * @param {object|null} computed  result of computeFacPricing
 * @returns {Array<{field: string, submitted: number, expected: number, diff: number}>}
 */
export function verifyFacPricing(posted, computed) {
  if (!posted || !computed?.ok || !computed.result) return [];
  const drifts = [];
  for (const [postedKey, computedKey] of VERIFIED_FIELDS) {
    const submitted = Number(posted[postedKey]);
    const expected = Number(computed.result[computedKey]);
    if (!Number.isFinite(submitted) || !Number.isFinite(expected)) continue;
    if (withinTolerance(submitted, expected)) continue;
    drifts.push({
      field: postedKey,
      submitted,
      expected,
      diff: Math.abs(submitted - expected),
    });
  }
  return drifts;
}

export function isFacPricingStrict() {
  const v = String(process.env.FAC_PRICING_STRICT || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Recompute, compare, log. Never throws on its own account — a verification
 * failure must not be able to take a save down, so a broken recompute is
 * logged and treated as "no drift observed".
 *
 * @returns {Promise<{drifts: Array, computed: object|null}>}
 */
export async function verifyFacPricingSave(riskId, posted, requestId) {
  try {
    const computed = await computeFacPricing(riskId, posted);
    const drifts = verifyFacPricing(posted, computed);
    if (drifts.length > 0) {
      logger.warn('fac pricing drift', {
        requestId,
        facRiskId: riskId,
        family: computed.family,
        driftCount: drifts.length,
        maxAbsDiff: Math.max(...drifts.map((d) => d.diff)),
        fields: drifts.map((d) => d.field),
      });
    }
    return { drifts, computed };
  } catch (err) {
    logger.warn('fac pricing verification skipped', {
      requestId, facRiskId: riskId, error: err?.message,
    });
    return { drifts: [], computed: null };
  }
}
