// server/src/services/facAccumulationService.js
//
// The capacity check against what has actually been written. This is the
// server half of finding F14.
//
// `mv_fac_accumulation` (migration 137) holds committed exposure by CRESTA
// zone, from bound facultative risks at the carrier's own share and from the
// aggregates declared on inforce treaties. It is a materialised view because
// the query spans two large tables and is read on every quote; it is
// refreshed on bind and nightly, alongside the existing benchmark refresh.
//
// The maths lives in shared/fac/accumulation.js so the browser can show the
// same answer the server enforces — the same arrangement the pricing engine
// uses, for the same reason.

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import {
  capacityCheck, lineSizeBasis,
} from '../../../shared/fac/accumulation.js';
import { buildExposureProfile, familyForClass } from '../../../shared/fac/index.js';

/**
 * Refresh the committed-exposure view.
 *
 * CONCURRENTLY needs the unique index migration 137 creates, and lets quotes
 * keep reading while it runs. It fails on a view that has never been
 * populated, so the first refresh falls back to a blocking one.
 *
 * @returns {Promise<{refreshed: boolean, concurrent: boolean, error?: string}>}
 */
export async function refreshAccumulation() {
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_fac_accumulation');
    return { refreshed: true, concurrent: true };
  } catch (err) {
    try {
      await pool.query('REFRESH MATERIALIZED VIEW public.mv_fac_accumulation');
      return { refreshed: true, concurrent: false };
    } catch (err2) {
      // Never let a refresh failure take a bind down: the check degrades to
      // slightly stale committed figures, which is a far smaller problem than
      // a carrier unable to bind.
      logger.warn('fac accumulation refresh failed', { error: err2?.message });
      return { refreshed: false, concurrent: false, error: err2?.message };
    }
  }
}

/**
 * The zones a risk touches, with what this risk would add to each.
 *
 * A risk's contribution is its PML at the carrier's share, per location —
 * the same quantity the view aggregates, so the two are comparable.
 *
 * @param {string} riskId
 * @returns {Promise<Array<{zone: string, adding: number}>>}
 */
export async function riskZoneContributions(riskId) {
  const { rows } = await pool.query(
    `SELECT l.cresta_zone AS zone,
            SUM(
              COALESCE(l.pd_si, 0) * COALESCE(l.pd_pml_pct, 1)
              * COALESCE(l.carrier_pd_share_pct, r.our_share_pct, r.ri_share_pct, 1)
              + COALESCE(l.bi_si, 0) * COALESCE(l.bi_pml_pct, 1)
              * COALESCE(l.carrier_bi_share_pct, l.carrier_pd_share_pct,
                         r.our_share_pct, r.ri_share_pct, 1)
            ) AS adding
       FROM public.fac_location l
       JOIN public.fac_risk r ON r.fac_risk_id = l.fac_risk_id
      WHERE l.fac_risk_id = $1
        AND l.cresta_zone IS NOT NULL AND l.cresta_zone <> ''
      GROUP BY 1
      ORDER BY 2 DESC`,
    [riskId],
  );
  return rows.map((r) => ({ zone: r.zone, adding: Number(r.adding) || 0 }));
}

/**
 * Committed exposure and the budget for a set of zones.
 *
 * The risk being quoted is excluded from the committed figure even if it is
 * already bound, so a re-check on a bound risk does not count it twice.
 *
 * @param {Array<string>} zones
 * @param {number|null} uwYear
 * @param {string|null} excludeRiskId
 * @returns {Promise<Map<string, {committed: Array, budget: object|null}>>}
 */
export async function zoneExposure(zones, uwYear, excludeRiskId = null) {
  const out = new Map();
  if (!zones || zones.length === 0) return out;

  const [committedRes, budgetRes, selfRes] = await Promise.all([
    pool.query(
      `SELECT cresta_zone, rating_family, source_kind, committed_si, committed_pml, risk_count
         FROM public.mv_fac_accumulation
        WHERE cresta_zone = ANY($1::text[])
          AND ($2::int IS NULL OR uw_year IS NULL OR uw_year = $2)`,
      [zones, uwYear ?? null],
    ),
    pool.query(
      `SELECT cresta_zone, peril, uw_year, budget_si, budget_pml, source
         FROM public.fac_zone_budget
        WHERE active = true
          AND cresta_zone = ANY($1::text[])
          AND (uw_year IS NULL OR uw_year = $2)
        ORDER BY uw_year NULLS LAST`,
      [zones, uwYear ?? null],
    ),
    excludeRiskId
      ? pool.query(
        `SELECT l.cresta_zone AS zone,
                SUM(
                  COALESCE(l.pd_si, 0) * COALESCE(l.pd_pml_pct, 1)
                  * COALESCE(l.carrier_pd_share_pct, r.our_share_pct, r.ri_share_pct, 1)
                  + COALESCE(l.bi_si, 0) * COALESCE(l.bi_pml_pct, 1)
                  * COALESCE(l.carrier_bi_share_pct, l.carrier_pd_share_pct,
                             r.our_share_pct, r.ri_share_pct, 1)
                ) AS committed
           FROM public.fac_location l
           JOIN public.fac_risk r ON r.fac_risk_id = l.fac_risk_id
          WHERE l.fac_risk_id = $1 AND r.status = 'BOUND'
            AND l.cresta_zone = ANY($2::text[])
          GROUP BY 1`,
        [excludeRiskId, zones],
      )
      : Promise.resolve({ rows: [] }),
  ]);

  const selfByZone = new Map(selfRes.rows.map((r) => [r.zone, Number(r.committed) || 0]));

  for (const zone of zones) {
    const committed = committedRes.rows.filter((r) => r.cresta_zone === zone);
    const own = selfByZone.get(zone) || 0;
    // Already-bound self-exposure comes out of the committed figure so a
    // re-check does not count this risk against itself.
    const adjusted = own > 0
      ? [...committed, { committed_pml: -own, committed_si: -own, source_kind: 'SELF_EXCLUDED' }]
      : committed;
    out.set(zone, {
      committed: adjusted,
      budget: budgetRes.rows.find((b) => b.cresta_zone === zone) || null,
    });
  }
  return out;
}

/**
 * What the bound book already carries on each of a set of cyber vendors.
 *
 * @param {Array<string>} vendorKeys
 * @param {string|null} excludeRiskId
 * @returns {Promise<Array<{vendor_key: string, committed_limit: number, risk_count: number}>>}
 */
export async function vendorExposure(vendorKeys, excludeRiskId = null) {
  if (!vendorKeys || vendorKeys.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT d.vendor_key,
            COALESCE(SUM(s.limit_amount * COALESCE(r.our_share_pct, r.ri_share_pct, 1)), 0)
              AS committed_limit,
            COUNT(DISTINCT r.fac_risk_id) AS risk_count
       FROM public.fac_cyber_dependency d
       JOIN public.fac_risk r ON r.fac_risk_id = d.fac_risk_id
       LEFT JOIN public.fac_risk_section s ON s.fac_risk_id = r.fac_risk_id
      WHERE r.status = 'BOUND'
        AND d.criticality = 'CRITICAL'
        AND d.vendor_key = ANY($1::text[])
        AND ($2::uuid IS NULL OR r.fac_risk_id <> $2)
      GROUP BY 1`,
    [vendorKeys.map((v) => String(v).toUpperCase()), excludeRiskId],
  );
  return rows.map((r) => ({
    vendor_key: r.vendor_key,
    committed_limit: Number(r.committed_limit) || 0,
    risk_count: Number(r.risk_count) || 0,
  }));
}

/**
 * What the bound book already carries in each of a set of war regions.
 *
 * @param {Array<string>} regions
 * @param {string|null} excludeRiskId
 * @returns {Promise<Array<{region: string, committed: number}>>}
 */
export async function warRegionExposure(regions, excludeRiskId = null) {
  if (!regions || regions.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT UPPER(s.exposure_detail->>'war_region') AS region,
            COALESCE(SUM(
              COALESCE(s.sum_insured, s.exposure_base, 0)
              * COALESCE(r.our_share_pct, r.ri_share_pct, 1)
            ), 0) AS committed
       FROM public.fac_risk_section s
       JOIN public.fac_risk r ON r.fac_risk_id = s.fac_risk_id
      WHERE r.status = 'BOUND'
        AND s.exposure_detail ? 'war_region'
        AND UPPER(s.exposure_detail->>'war_region') = ANY($1::text[])
        AND ($2::uuid IS NULL OR r.fac_risk_id <> $2)
      GROUP BY 1`,
    [regions.map((v) => String(v).toUpperCase()), excludeRiskId],
  );
  return rows.map((r) => ({ region: r.region, committed: Number(r.committed) || 0 }));
}

/**
 * The whole capacity check for one risk.
 *
 * @param {string} riskId
 * @returns {Promise<object>}
 */
export async function checkFacCapacity(riskId) {
  const [riskRes, sectionsRes, locationsRes, pricingRes] = await Promise.all([
    pool.query(
      `SELECT r.*, c.rating_family
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
      `SELECT pd_si, bi_si, cresta_zone FROM public.fac_location WHERE fac_risk_id = $1`,
      [riskId],
    ),
    pool.query(
      `SELECT max_capacity_pct FROM public.fac_pricing WHERE fac_risk_id = $1`,
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

  const family = familyForClass({ rating_family: risk.rating_family });
  const sections = sectionsRes.rows;
  const exposure = buildExposureProfile({ risk, sections, locations: locationsRes.rows });
  const line = lineSizeBasis({ family, exposure, sections, risk });

  const contributions = await riskZoneContributions(riskId);
  const zoneMap = await zoneExposure(
    contributions.map((c) => c.zone), risk.uw_year, riskId,
  );

  const vendorKeys = sections.flatMap((s) => (s.exposure_detail?.dependencies || []))
    .map((d) => (typeof d === 'string' ? d : d?.vendor_key || d?.vendorKey))
    .filter(Boolean);
  const warRegions = sections.map((s) => s.exposure_detail?.war_region).filter(Boolean);

  const [vendors, warRegionsBook] = await Promise.all([
    vendorExposure(vendorKeys, riskId),
    warRegionExposure(warRegions, riskId),
  ]);

  const result = capacityCheck({
    family,
    sections,
    perRiskLine: {
      lineSize: line.amount,
      maxCapacityPct: pricingRes.rows[0]?.max_capacity_pct ?? null,
      writtenShare: risk.our_share_pct ?? risk.ri_share_pct ?? null,
    },
    zones: contributions.map((c) => ({
      zone: c.zone,
      thisRisk: c.adding,
      committed: zoneMap.get(c.zone)?.committed || [],
      budget: zoneMap.get(c.zone)?.budget || null,
    })),
    systemic: { vendorExposure: vendors, warRegionExposure: warRegionsBook },
  });

  return {
    ...result,
    family: family.code,
    line_size: line.amount,
    line_basis: line.basis,
    zones: contributions.map((c) => c.zone),
  };
}
