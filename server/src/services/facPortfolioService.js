// server/src/services/facPortfolioService.js
//
// Portfolio analytics for the facultative book. Design doc §6, Phase 4
// item 22: technical adequacy distribution, hit ratio, capacity utilisation.
//
// These three exist because pricing a risk well and running a book well are
// different problems. A carrier can be technically right on every quote and
// still lose money by binding only the ones the market underprices — which is
// exactly what a good technical price plus no feedback loop produces.
//
//   • **Technical adequacy** is quoted ÷ technical. Above 1.00 the price is
//     ahead of the model; below it the underwriter has discounted. The
//     distribution over a book is the honest picture: a mean of 1.02 made of
//     halves at 0.7 and 1.3 is not a book priced at 1.02.
//
//   • **Hit ratio** is bound ÷ quoted, banded by adequacy. Read together,
//     the two answer the question that matters: are we winning the business
//     we price cheaply? A hit ratio that falls away above 1.0 and spikes
//     below 0.9 is adverse selection with a number on it.
//
//   • **Capacity utilisation** is committed exposure against the zone budget,
//     from the same view the bind gate reads.

import { pool } from '../db/pool.js';
import { isFacPricingStrict } from './facPricingService.js';
import { buildExposureProfile } from '../../../shared/fac/index.js';
import { renewalSnapshot, renewalComparison } from '../../../shared/fac/renewal.js';

/** The adequacy bands the distribution and the hit ratio share. */
const ADEQUACY_BANDS = [
  { label: '< 0.80', min: null, max: 0.80 },
  { label: '0.80 – 0.90', min: 0.80, max: 0.90 },
  { label: '0.90 – 1.00', min: 0.90, max: 1.00 },
  { label: '1.00 – 1.10', min: 1.00, max: 1.10 },
  { label: '1.10 – 1.25', min: 1.10, max: 1.25 },
  { label: '≥ 1.25', min: 1.25, max: null },
];

function bandFor(adequacy) {
  return ADEQUACY_BANDS.find(
    (b) => (b.min === null || adequacy >= b.min) && (b.max === null || adequacy < b.max),
  )?.label ?? null;
}

/**
 * Every quoted or bound risk with both a quoted and a technical rate, which
 * is what an adequacy figure needs.
 *
 * Risks priced before the technical build-up existed have no
 * `technical_gross_rate_pm` and are counted separately rather than silently
 * dropped — a denominator that quietly excludes the old book would flatter
 * every ratio computed from it.
 *
 * @param {object} filters {uwYear, family, region}
 * @returns {Promise<Array<object>>}
 */
async function loadPricedRisks({ uwYear = null, family = null, region = null } = {}) {
  const { rows } = await pool.query(
    `SELECT r.fac_risk_id, r.insured_name, r.status, r.uw_year, r.cedant_region,
            c.rating_family, c.class_name,
            p.final_rate_per_mille AS quoted_rate_pm,
            p.technical_gross_rate_pm,
            p.technical_premium, p.final_premium,
            r.our_share_pct, r.ri_share_pct
       FROM public.fac_risk r
       LEFT JOIN public.fac_class_of_business c ON c.fac_cob_id = r.fac_cob_id
       LEFT JOIN public.fac_pricing p ON p.fac_risk_id = r.fac_risk_id
      WHERE r.status IN ('QUOTED', 'BOUND', 'DECLINED', 'NTU')
        AND ($1::int  IS NULL OR r.uw_year = $1)
        AND ($2::text IS NULL OR c.rating_family = $2)
        AND ($3::text IS NULL OR r.cedant_region = $3)`,
    [uwYear, family, region],
  );
  return rows;
}

/**
 * The technical adequacy distribution.
 *
 * @param {object} filters
 * @returns {Promise<object>}
 */
export async function adequacyDistribution(filters = {}) {
  const rows = await loadPricedRisks(filters);
  const measurable = [];
  let unmeasured = 0;

  for (const r of rows) {
    const quoted = Number(r.quoted_rate_pm);
    const technical = Number(r.technical_gross_rate_pm);
    if (!Number.isFinite(quoted) || !Number.isFinite(technical) || technical <= 0) {
      unmeasured += 1;
      continue;
    }
    measurable.push({ ...r, adequacy: quoted / technical });
  }

  const byBand = new Map(ADEQUACY_BANDS.map((b) => [b.label, { band: b.label, quoted: 0, bound: 0 }]));
  for (const r of measurable) {
    const band = byBand.get(bandFor(r.adequacy));
    if (!band) continue;
    band.quoted += 1;
    if (r.status === 'BOUND') band.bound += 1;
  }

  const values = measurable.map((r) => r.adequacy).sort((a, b) => a - b);
  const quantile = (q) => {
    if (values.length === 0) return null;
    const idx = (values.length - 1) * q;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? values[lo] : values[lo] + (idx - lo) * (values[hi] - values[lo]);
  };

  return {
    count: measurable.length,
    // Stated, not hidden: these are risks priced before the technical
    // build-up existed, and a ratio computed without saying so is a ratio
    // over a book nobody chose.
    unmeasured,
    mean: values.length > 0 ? values.reduce((t, v) => t + v, 0) / values.length : null,
    median: quantile(0.5),
    p25: quantile(0.25),
    p75: quantile(0.75),
    below_technical: measurable.filter((r) => r.adequacy < 1).length,
    bands: [...byBand.values()].map((b) => ({
      ...b,
      hit_ratio: b.quoted > 0 ? b.bound / b.quoted : null,
    })),
  };
}

/**
 * Hit ratio overall and by family, with the adequacy of what was won and
 * what was lost beside it.
 *
 * @param {object} filters
 * @returns {Promise<object>}
 */
export async function hitRatio(filters = {}) {
  const rows = await loadPricedRisks(filters);
  const byFamily = new Map();

  const mean = (list) => (list.length > 0 ? list.reduce((t, v) => t + v, 0) / list.length : null);

  for (const r of rows) {
    const key = r.rating_family || 'UNMAPPED';
    if (!byFamily.has(key)) {
      byFamily.set(key, {
        family: key, quoted: 0, bound: 0, declined: 0, ntu: 0,
        boundAdequacy: [], lostAdequacy: [],
      });
    }
    const f = byFamily.get(key);
    f.quoted += 1;
    if (r.status === 'BOUND') f.bound += 1;
    if (r.status === 'DECLINED') f.declined += 1;
    if (r.status === 'NTU') f.ntu += 1;

    const quoted = Number(r.quoted_rate_pm);
    const technical = Number(r.technical_gross_rate_pm);
    if (Number.isFinite(quoted) && Number.isFinite(technical) && technical > 0) {
      (r.status === 'BOUND' ? f.boundAdequacy : f.lostAdequacy).push(quoted / technical);
    }
  }

  const families = [...byFamily.values()].map((f) => ({
    family: f.family,
    quoted: f.quoted,
    bound: f.bound,
    declined: f.declined,
    ntu: f.ntu,
    hit_ratio: f.quoted > 0 ? f.bound / f.quoted : null,
    mean_adequacy_bound: mean(f.boundAdequacy),
    mean_adequacy_lost: mean(f.lostAdequacy),
    // The number that matters. Negative means the book is winning the risks
    // it prices below technical and losing the ones it prices above — which
    // is adverse selection, whatever the average adequacy says.
    selection_gap: mean(f.boundAdequacy) !== null && mean(f.lostAdequacy) !== null
      ? mean(f.boundAdequacy) - mean(f.lostAdequacy)
      : null,
  })).sort((a, b) => b.quoted - a.quoted);

  const totalQuoted = rows.length;
  const totalBound = rows.filter((r) => r.status === 'BOUND').length;

  return {
    quoted: totalQuoted,
    bound: totalBound,
    hit_ratio: totalQuoted > 0 ? totalBound / totalQuoted : null,
    families,
  };
}

/**
 * Capacity utilisation by zone, from the same view the bind gate reads.
 *
 * A zone with no budget appears with a null utilisation rather than being
 * dropped: "we are carrying 400m here and nobody has set a limit" is the
 * most useful row on the screen, not the least.
 *
 * @param {object} filters
 * @returns {Promise<object>}
 */
export async function capacityUtilisation({ uwYear = null } = {}) {
  // Committed exposure is aggregated per zone FIRST, and then exactly one
  // budget row is attached per zone via a LATERAL pick (F75). The old shape
  // LEFT JOINed fac_zone_budget before grouping and grouped by the budget
  // columns, so a zone with more than one active budget row (a NULL-uw_year
  // default plus a year- or peril-specific row — expressly allowed by the
  // UNIQUE(cresta_zone, peril, uw_year) schema) appeared once per budget,
  // each row carrying the zone's FULL committed exposure — double-counting
  // committed and inflating over_budget.
  //
  // Budget precedence (deterministic): the most specific uw_year first — a
  // budget whose uw_year equals the filter (or the all-years NULL budget when
  // no filter is given), then the all-years default, then the latest
  // year-specific row; within a year, the zone-wide 'ALL'-peril budget
  // before per-peril ones, then peril alphabetically as a final tiebreak.
  const { rows } = await pool.query(
    `SELECT z.cresta_zone, z.committed_si, z.committed_pml, z.risk_count,
            b.budget_si, b.budget_pml, b.source AS budget_source
       FROM (
              SELECT a.cresta_zone,
                     SUM(a.committed_si)  AS committed_si,
                     SUM(a.committed_pml) AS committed_pml,
                     SUM(a.risk_count)    AS risk_count
                FROM public.mv_fac_accumulation a
               WHERE ($1::int IS NULL OR a.uw_year IS NULL OR a.uw_year = $1)
               GROUP BY a.cresta_zone
            ) z
       LEFT JOIN LATERAL (
              SELECT b.budget_si, b.budget_pml, b.source
                FROM public.fac_zone_budget b
               WHERE b.cresta_zone = z.cresta_zone
                 AND b.active = true
                 AND ($1::int IS NULL OR b.uw_year IS NULL OR b.uw_year = $1)
               ORDER BY (b.uw_year IS NOT DISTINCT FROM $1::int) DESC,
                        (b.uw_year IS NULL) DESC,
                        b.uw_year DESC,
                        (b.peril = 'ALL') DESC,
                        b.peril
               LIMIT 1
            ) b ON true
      ORDER BY z.committed_pml DESC NULLS LAST, z.committed_si DESC`,
    [uwYear],
  );

  const zones = rows.map((r) => {
    const committedPml = Number(r.committed_pml) || 0;
    const committedSi = Number(r.committed_si) || 0;
    const budget = r.budget_pml !== null && r.budget_pml !== undefined
      ? Number(r.budget_pml)
      : (r.budget_si !== null && r.budget_si !== undefined ? Number(r.budget_si) : null);
    const against = r.budget_pml !== null && r.budget_pml !== undefined ? committedPml : committedSi;
    return {
      cresta_zone: r.cresta_zone,
      committed_si: committedSi,
      committed_pml: committedPml,
      risk_count: Number(r.risk_count) || 0,
      budget,
      budget_source: r.budget_source || null,
      utilisation: budget && budget > 0 ? against / budget : null,
      headroom: budget !== null ? budget - against : null,
    };
  });

  return {
    zones,
    zones_without_budget: zones.filter((z) => z.budget === null).length,
    over_budget: zones.filter((z) => z.utilisation !== null && z.utilisation > 1).length,
  };
}

/**
 * The drift rate: how often the client's price and the server's disagree.
 *
 * This exists to answer one question with data instead of nerve — is it safe
 * to turn FAC_PRICING_STRICT on? The design's condition is a drift rate
 * observed at zero for a full pricing cycle, and until Phase 5 the
 * disagreements were logged and the agreements were not, so the rate had no
 * denominator and the question had no answer.
 *
 * `readyForStrict` is a reading of the evidence, not a recommendation to act
 * on it: a clean window on ten saves is not the same as a clean window on a
 * quarter's business, and the caller can see both numbers.
 *
 * @param {object} args {days, minObservations}
 * @returns {Promise<object>}
 */
export async function driftRate({ days = 90, minObservations = 100 } = {}) {
  const [totals, byFamily, recent] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS observations,
              COUNT(*) FILTER (WHERE drift_count > 0)::int AS with_drift,
              MAX(max_abs_diff) AS worst_diff,
              MIN(observed_at) AS first_seen,
              MAX(observed_at) AS last_seen,
              MAX(observed_at) FILTER (WHERE drift_count > 0) AS last_drift_at
         FROM public.fac_pricing_drift
        WHERE observed_at >= now() - ($1 || ' days')::interval`,
      [String(days)],
    ),
    pool.query(
      `SELECT COALESCE(family_code, 'UNMAPPED') AS family,
              COUNT(*)::int AS observations,
              COUNT(*) FILTER (WHERE drift_count > 0)::int AS with_drift,
              MAX(max_abs_diff) AS worst_diff
         FROM public.fac_pricing_drift
        WHERE observed_at >= now() - ($1 || ' days')::interval
        GROUP BY 1
        ORDER BY 3 DESC, 2 DESC`,
      [String(days)],
    ),
    pool.query(
      `SELECT fac_risk_id, observed_at, family_code, drift_count, max_abs_diff,
              fields, request_id
         FROM public.fac_pricing_drift
        WHERE drift_count > 0
          AND observed_at >= now() - ($1 || ' days')::interval
        ORDER BY observed_at DESC
        LIMIT 20`,
      [String(days)],
    ),
  ]);

  const t = totals.rows[0] || {};
  const observations = Number(t.observations) || 0;
  const withDrift = Number(t.with_drift) || 0;
  const rate = observations > 0 ? withDrift / observations : null;

  return {
    window_days: days,
    observations,
    with_drift: withDrift,
    drift_rate: rate,
    worst_diff: t.worst_diff === null || t.worst_diff === undefined
      ? null : Number(t.worst_diff),
    first_seen: t.first_seen || null,
    last_seen: t.last_seen || null,
    last_drift_at: t.last_drift_at || null,
    strict_mode: isFacPricingStrict(),
    // Both conditions, reported separately, because "no drift" over too few
    // saves is not evidence of anything.
    ready_for_strict: rate === 0 && observations >= minObservations,
    min_observations: minObservations,
    verdict: observations === 0
      ? 'No verifications recorded in this window — the drift rate is unknown, not zero.'
      : rate === 0 && observations >= minObservations
        ? `${observations} verifications, none disagreeing. The evidence supports enabling `
          + 'FAC_PRICING_STRICT.'
        : rate === 0
          ? `${observations} verifications, none disagreeing — but that is under the `
            + `${minObservations} this window asks for before calling it a pattern.`
          : `${withDrift} of ${observations} verifications disagreed. Fix the divergence `
            + 'before enabling strict mode, or every stale browser tab becomes a failed save.',
    families: byFamily.rows.map((r) => ({
      family: r.family,
      observations: Number(r.observations),
      with_drift: Number(r.with_drift),
      drift_rate: Number(r.observations) > 0 ? Number(r.with_drift) / Number(r.observations) : null,
      worst_diff: r.worst_diff === null ? null : Number(r.worst_diff),
    })),
    recent_drifts: recent.rows.map((r) => ({
      fac_risk_id: r.fac_risk_id,
      observed_at: r.observed_at,
      family: r.family_code,
      drift_count: r.drift_count,
      max_abs_diff: r.max_abs_diff === null ? null : Number(r.max_abs_diff),
      fields: r.fields,
      request_id: r.request_id,
    })),
  };
}

/**
 * The expiring risk behind a renewal, and why the price moved.
 *
 * The link is `expiring_reference`, which the underwriter sets when the
 * renewal is created. It is matched against `bound_reference` first — the
 * reference a bound risk actually carries — and against `fac_ref` second, so
 * a renewal referencing a quote that was never bound still finds its
 * predecessor.
 *
 * @param {string} riskId
 * @returns {Promise<object>}
 */
export async function renewalDifference(riskId) {
  const load = async (id) => {
    const [riskRes, pricingRes, sectionsRes, locationsRes] = await Promise.all([
      pool.query('SELECT * FROM public.fac_risk WHERE fac_risk_id = $1', [id]),
      pool.query('SELECT * FROM public.fac_pricing WHERE fac_risk_id = $1', [id]),
      pool.query(
        'SELECT * FROM public.fac_risk_section WHERE fac_risk_id = $1 ORDER BY section_no', [id],
      ),
      pool.query('SELECT pd_si, bi_si FROM public.fac_location WHERE fac_risk_id = $1', [id]),
    ]);
    const risk = riskRes.rows[0];
    if (!risk) return null;
    const exposure = buildExposureProfile({
      risk, sections: sectionsRes.rows, locations: locationsRes.rows,
    });
    return renewalSnapshot(risk, pricingRes.rows[0] || null, exposure);
  };

  const renewing = await load(riskId);
  if (!renewing) {
    const err = new Error('Risk not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const { rows: riskRows } = await pool.query(
    'SELECT expiring_reference, renewal_or_new FROM public.fac_risk WHERE fac_risk_id = $1',
    [riskId],
  );
  const reference = String(riskRows[0]?.expiring_reference || '').trim();

  if (!reference) {
    return {
      ...renewalComparison({ expiring: null, renewing }),
      expiring_reference: null,
      renewal_or_new: riskRows[0]?.renewal_or_new || null,
      note: riskRows[0]?.renewal_or_new === 'RENEWAL'
        ? 'This is marked as a renewal but carries no expiring reference, so there is nothing '
          + 'to compare it against. Set the expiring reference on the Risk Detail screen.'
        : 'This is not a renewal.',
    };
  }

  // The bound reference is what a bound risk carries; fac_ref catches a
  // renewal that references a predecessor which never bound.
  const { rows: priorRows } = await pool.query(
    `SELECT fac_risk_id FROM public.fac_risk
      WHERE fac_risk_id <> $1
        AND (bound_reference = $2 OR fac_ref = $2)
      ORDER BY (bound_reference = $2) DESC, uw_year DESC NULLS LAST
      LIMIT 1`,
    [riskId, reference],
  );

  const expiring = priorRows[0] ? await load(priorRows[0].fac_risk_id) : null;

  return {
    ...renewalComparison({ expiring, renewing }),
    expiring_reference: reference,
    renewal_or_new: riskRows[0]?.renewal_or_new || null,
    note: expiring
      ? null
      : `No risk in the book carries the reference "${reference}". The comparison is empty `
        + 'because the predecessor is not here, not because nothing changed.',
  };
}
