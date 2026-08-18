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

/** The adequacy bands the distribution and the hit ratio share. */
export const ADEQUACY_BANDS = [
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
export async function loadPricedRisks({ uwYear = null, family = null, region = null } = {}) {
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
  const { rows } = await pool.query(
    `SELECT a.cresta_zone,
            SUM(a.committed_si)  AS committed_si,
            SUM(a.committed_pml) AS committed_pml,
            SUM(a.risk_count)    AS risk_count,
            b.budget_si, b.budget_pml, b.source AS budget_source
       FROM public.mv_fac_accumulation a
       LEFT JOIN public.fac_zone_budget b
              ON b.cresta_zone = a.cresta_zone
             AND b.active = true
             AND (b.uw_year IS NULL OR b.uw_year = a.uw_year)
      WHERE ($1::int IS NULL OR a.uw_year IS NULL OR a.uw_year = $1)
      GROUP BY a.cresta_zone, b.budget_si, b.budget_pml, b.source
      ORDER BY 3 DESC NULLS LAST, 2 DESC`,
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
