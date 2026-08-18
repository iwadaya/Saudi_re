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
import { priceFacRiskFull } from '../../../shared/fac/index.js';

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
 * Exposure curves configured for a family, with their tabulated points.
 *
 * Returned as bands: which curve applies to which size of risk. A family
 * with no bands configured cannot be exposure-rated, and the method says so
 * rather than falling back to a curve nobody chose.
 *
 * @param {string} familyCode
 * @param {Date|string|null} [asOf]
 */
export async function loadCurveBands(familyCode, asOf = null) {
  if (!familyCode) return [];
  const { rows } = await pool.query(
    `SELECT b.min_exposure, b.max_exposure,
            c.curve_id, c.curve_code, c.curve_name, c.kind, c.params, c.source
       FROM public.fac_curve_band b
       JOIN public.fac_exposure_curve c ON c.curve_id = b.curve_id
      WHERE b.family_code = $1
        AND c.active = true
        AND c.effective_from <= COALESCE($2::date, CURRENT_DATE)
        AND (c.effective_to IS NULL OR c.effective_to >= COALESCE($2::date, CURRENT_DATE))
      ORDER BY b.min_exposure`,
    [familyCode, asOf || null],
  );
  if (rows.length === 0) return [];

  const tabulated = rows.filter((r) => r.kind === 'TABULATED').map((r) => r.curve_id);
  const pointsByCurve = new Map();
  if (tabulated.length > 0) {
    const { rows: pts } = await pool.query(
      `SELECT curve_id, x, y FROM public.fac_exposure_curve_point
        WHERE curve_id = ANY($1::uuid[]) ORDER BY curve_id, x`,
      [tabulated],
    );
    for (const p of pts) {
      if (!pointsByCurve.has(p.curve_id)) pointsByCurve.set(p.curve_id, []);
      pointsByCurve.get(p.curve_id).push({ x: p.x, y: p.y });
    }
  }

  return rows.map((r) => ({
    min_exposure: r.min_exposure,
    max_exposure: r.max_exposure,
    curve: {
      curve_id: r.curve_id,
      curve_code: r.curve_code,
      curve_name: r.curve_name,
      kind: r.kind,
      params: r.params || {},
      source: r.source,
      points: pointsByCurve.get(r.curve_id) || [],
    },
  }));
}

/**
 * The rate tables a Phase 3 family needs.
 *
 * All of these ship EMPTY (migration 136). A family with nothing loaded
 * reports itself unavailable with a reason naming the table to load, which
 * is the whole point: a rate nobody can attribute is the problem this
 * redesign exists to fix, and a plausible default is worse than a refusal
 * because nobody goes looking for it.
 *
 * Loaded per family so a property risk does not pay for a hull query.
 *
 * @param {string|null} familyCode
 * @param {Date|string|null} [asOf]
 * @returns {Promise<object>} the `rates` bag priceFacRiskFull passes to the family
 */
export async function loadFamilyRates(familyCode, asOf = null) {
  const effective = `effective_from <= COALESCE($1::date, CURRENT_DATE)
        AND (effective_to IS NULL OR effective_to >= COALESCE($1::date, CURRENT_DATE))`;

  if (familyCode === 'LIABILITY_LIMIT' || familyCode === 'MARINE_LIABILITY'
      || familyCode === 'CYBER_LIMIT') {
    const [ratesRes, curvesRes] = await Promise.all([
      pool.query(
        `SELECT rate_id, fac_cob_id, territory, basis_unit, basis_divisor, basic_limit,
                loss_cost_per_unit, hazard_band, source
           FROM public.fac_liability_base_rate
          WHERE active = true AND ${effective}`,
        [asOf || null],
      ),
      pool.query(
        `SELECT curve_id, curve_code, curve_name, family_code, territory, kind,
                basic_limit, params, source
           FROM public.fac_ilf_curve
          WHERE active = true AND ${effective}`,
        [asOf || null],
      ),
    ]);
    const tabulated = curvesRes.rows.filter((c) => c.kind === 'TABULATED').map((c) => c.curve_id);
    const pointsByCurve = new Map();
    if (tabulated.length > 0) {
      const { rows: pts } = await pool.query(
        `SELECT curve_id, limit_amount, ilf FROM public.fac_ilf_point
          WHERE curve_id = ANY($1::uuid[]) ORDER BY curve_id, limit_amount`,
        [tabulated],
      );
      for (const pt of pts) {
        if (!pointsByCurve.has(pt.curve_id)) pointsByCurve.set(pt.curve_id, []);
        pointsByCurve.get(pt.curve_id).push({ limit_amount: pt.limit_amount, ilf: pt.ilf });
      }
    }
    return {
      liabilityBaseRates: ratesRes.rows,
      ilfCurves: curvesRes.rows.map((c) => ({
        ...c, params: c.params || {}, points: pointsByCurve.get(c.curve_id) || [],
      })),
    };
  }

  if (familyCode === 'TRANSIT_VALUES') {
    const [transitRes, warRes] = await Promise.all([
      pool.query(
        `SELECT commodity, conveyance, route_region, rate_pm, packing_factor, source
           FROM public.fac_transit_base_rate
          WHERE active = true AND ${effective}`,
        [asOf || null],
      ),
      pool.query(
        `SELECT region, basis, rate_pm, breach_ap_pm, source, effective_from
           FROM public.fac_war_rate
          WHERE active = true AND ${effective}
          ORDER BY effective_from DESC`,
        [asOf || null],
      ),
    ]);
    return { transitRates: transitRes.rows, warRates: warRes.rows };
  }

  if (familyCode === 'HULL_VALUE') {
    const [hullRes, factorRes, warRes] = await Promise.all([
      pool.query(
        `SELECT vessel_type, tonnage_min, tonnage_max, rate_pm, source
           FROM public.fac_hull_base_rate
          WHERE active = true AND ${effective}`,
        [asOf || null],
      ),
      pool.query(
        `SELECT factor_kind, factor_key, factor, source
           FROM public.fac_hull_factor WHERE active = true`,
      ),
      pool.query(
        `SELECT region, basis, rate_pm, breach_ap_pm, source, effective_from
           FROM public.fac_war_rate
          WHERE active = true AND ${effective}
          ORDER BY effective_from DESC`,
        [asOf || null],
      ),
    ]);
    return {
      hullRates: hullRes.rows, hullFactors: factorRes.rows, warRates: warRes.rows,
    };
  }

  return {};
}

/**
 * Bound comparables for the benchmark: what this book charged for risks of
 * the same family in the same region.
 *
 * Only BOUND risks count — a quote that was never taken up says what the
 * carrier was willing to charge, not what the market paid. The current risk
 * is excluded so a renewal cannot benchmark against itself.
 *
 * @param {object} risk fac_risk row (needs rating_family, cedant_region)
 * @returns {Promise<{observations: Array, scope: string}>}
 */
export async function loadBenchmarkObservations(risk) {
  if (!risk?.rating_family) return { observations: [], scope: null };
  const { rows } = await pool.query(
    `SELECT p.final_rate_per_mille AS rate_pm, r.uw_year
       FROM public.fac_risk r
       JOIN public.fac_pricing p ON p.fac_risk_id = r.fac_risk_id
       LEFT JOIN public.fac_class_of_business c ON c.fac_cob_id = r.fac_cob_id
      WHERE r.status = 'BOUND'
        AND r.fac_risk_id <> $1
        AND c.rating_family = $2
        AND ($3::text IS NULL OR r.cedant_region = $3)
        AND p.final_rate_per_mille > 0
      ORDER BY r.uw_year DESC
      LIMIT 500`,
    [risk.fac_risk_id, risk.rating_family, risk.cedant_region || null],
  );
  const scope = [risk.rating_family, risk.cedant_region].filter(Boolean).join(' · ');
  return { observations: rows, scope: scope || null };
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
  const [riskRes, sectionsRes, locationsRes, factorsRes, pricingRes, lossesRes, basisRes] = await Promise.all([
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
              market_rate_pm, extra_cover_loadings,
              cat_load_pm, risk_load_pm, internal_expense_pct, blend_weights,
              blend_override_reason
         FROM public.fac_pricing WHERE fac_risk_id = $1`,
      [riskId],
    ),
    pool.query(
      `SELECT loss_year, loss_date, fgu_paid, fgu_outstanding, fgu_incurred, is_open,
              indexed_incurred, as_if_incurred, development_factor,
              exclude_from_rating, exclusion_reason
         FROM public.fac_loss_history WHERE fac_risk_id = $1 ORDER BY loss_year`,
      [riskId],
    ),
    pool.query(
      `SELECT loss_year, exposure_base, exposure_unit, premium, rate_change_pct, claim_count
         FROM public.fac_experience_basis WHERE fac_risk_id = $1 ORDER BY loss_year`,
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

  // Phase 2 inputs. Each is optional — a method with no data reports itself
  // unavailable and the blend carries on with the ones that do have data.
  const [curveBands, benchmark, rates] = await Promise.all([
    loadCurveBands(risk.rating_family, risk.inception_date),
    loadBenchmarkObservations(risk),
    loadFamilyRates(risk.rating_family, risk.inception_date),
  ]);

  const storedWeights = stored.blend_weights && typeof stored.blend_weights === 'object'
    ? stored.blend_weights : null;
  const weightOverride = overrides.weight_override
    ?? (storedWeights && Object.keys(storedWeights).length > 0
      ? { weights: storedWeights, reasonCode: stored.blend_override_reason }
      : null);

  const priced = priceFacRiskFull({
    risk,
    cob: { rating_family: risk.rating_family },
    sections: sectionsRes.rows,
    locations: locationsRes.rows,
    inputs,
    referenceData,
    losses: lossesRes.rows,
    experienceBasis: basisRes.rows,
    curveBands,
    rates,
    benchmarks: benchmark.observations,
    benchmarkScope: benchmark.scope,
    loads: {
      catLoadPm: num(pick('cat_load_pm')),
      riskLoadPct: num(pick('risk_load_pct')),
      internalExpensePct: num(pick('internal_expense_pct')),
    },
    weightOverride,
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


/**
 * Persist the per-method results behind a priced row.
 *
 * fac_pricing keeps the signed-off answer; this keeps how it was arrived
 * at — every candidate, what it said, the weight it was given and whether
 * a human chose that weight. Replace-all per risk, so a method that stops
 * being available stops being recorded.
 *
 * @param {import('pg').PoolClient} client  inside the save transaction
 * @param {string} riskId
 * @param {object|null} technical  buildTechnicalPremium output
 */
export async function persistPricingMethods(client, riskId, technical) {
  await client.query('DELETE FROM public.fac_pricing_method WHERE fac_risk_id = $1', [riskId]);
  if (!technical?.candidates?.length) return;

  const z = technical.credibility?.z ?? null;
  for (const c of technical.candidates) {
    const weight = technical.weights?.[c.code] ?? null;
    await client.query(
      `INSERT INTO public.fac_pricing_method
         (fac_risk_id, method_code, available, unavailable_reason,
          loss_cost, rate_pm, weight, weight_source, override_reason_code,
          credibility_z, diagnostics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        riskId,
        c.code,
        Boolean(c.available),
        c.unavailableReason || null,
        c.lossCost ?? null,
        c.ratePm ?? null,
        weight,
        weight == null ? 'EXCLUDED' : technical.weightSource || 'MECHANICAL',
        technical.weightOverrideReason || null,
        c.role === 'EXPERIENCE' ? z : null,
        JSON.stringify(c.diagnostics || {}),
      ],
    );
  }
}
