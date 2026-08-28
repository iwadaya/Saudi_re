// Pull weighted LDFs for a single (class, triangle_type) at the best scope
// the data supports. Returns the curve plus the scope decision so the UI
// can show "country (12 contracts)" or "region (fallback — only 3 contracts in KSA)".
import { logger } from '../../lib/logger.js';

const MIN_CONTRACTS_FOR_SCOPE = 5;

// A scope (country / region) is only good enough to carry the whole curve if
// EVERY dev-month row meets the contract-count threshold — not just the first
// (most-mature) row. Early dev months almost always have more contributing
// contracts than the sparse tail, so keying acceptance off rows[0] let a well-
// populated 12-month row validate a 120-month row backed by a single contract.
function scopeHasEnoughContracts(rows) {
  return rows.length > 0
    && rows.every((r) => Number(r.n_contracts) >= MIN_CONTRACTS_FOR_SCOPE);
}

export async function getBenchmarkLdfForClass(client, {
  classOfBusinessId, countryId, region, triangleType, treatyCategory,
}) {
  if (!classOfBusinessId || !triangleType) {
    throw new Error('getBenchmarkLdfForClass: classOfBusinessId and triangleType are required');
  }
  if (treatyCategory !== 'PROPORTIONAL' && treatyCategory !== 'NON_PROPORTIONAL') {
    // No category = no benchmark. Proportional and non-proportional triangles
    // develop differently, so we never blend across the boundary.
    return { scope: 'NONE', countryId: null, region: null, rows: [] };
  }

  // Try country first
  if (countryId) {
    const country = await client.query(
      `SELECT dev_month, weighted_ldf, simple_ldf, n_contracts, total_premium, stddev_ldf
         FROM public.mv_ldf_benchmark_country
        WHERE class_of_business_id = $1 AND country_id = $2 AND triangle_type = $3
          AND treaty_category = $4
        ORDER BY dev_month`,
      [classOfBusinessId, countryId, triangleType, treatyCategory],
    );
    if (scopeHasEnoughContracts(country.rows)) {
      return { scope: 'COUNTRY', countryId, region: null, rows: country.rows };
    }
  }

  // Fallback to region
  if (region) {
    const reg = await client.query(
      `SELECT dev_month, weighted_ldf, simple_ldf, n_contracts, total_premium, stddev_ldf
         FROM public.mv_ldf_benchmark_region
        WHERE class_of_business_id = $1 AND region = $2 AND triangle_type = $3
          AND treaty_category = $4
        ORDER BY dev_month`,
      [classOfBusinessId, region, triangleType, treatyCategory],
    );
    if (scopeHasEnoughContracts(reg.rows)) {
      return { scope: 'REGION', countryId: null, region, rows: reg.rows };
    }
  }

  // Final fallback: global
  const global = await client.query(
    `SELECT dev_month, weighted_ldf, simple_ldf, n_contracts, total_premium, stddev_ldf
       FROM public.mv_ldf_benchmark_global
      WHERE class_of_business_id = $1 AND triangle_type = $2 AND treaty_category = $3
      ORDER BY dev_month`,
    [classOfBusinessId, triangleType, treatyCategory],
  );
  if (global.rows.length > 0) {
    return { scope: 'GLOBAL', countryId: null, region: null, rows: global.rows };
  }

  // Nothing — class has zero contributing contracts anywhere
  return { scope: 'NONE', countryId: null, region: null, rows: [] };
}

// Refresh order matters: the three benchmark views read from
// mv_ldf_contributions, so it must refresh first. Names/order copied from
// migration 108's public.refresh_ldf_benchmarks().
const BENCHMARK_VIEWS = [
  'public.mv_ldf_contributions',
  'public.mv_ldf_benchmark_country',
  'public.mv_ldf_benchmark_region',
  'public.mv_ldf_benchmark_global',
];

/**
 * Trigger a synchronous refresh of all benchmark views.
 * Called after a contract reaches a terminal underwriting state
 * (SIGNED / DECLINED / NTU), since each of those changes the
 * benchmark dataset. Safe to call repeatedly — CONCURRENTLY refresh
 * won't lock readers.
 *
 * The four REFRESH ... CONCURRENTLY statements are issued as separate
 * top-level queries, NOT via SELECT public.refresh_ldf_benchmarks():
 * stock PostgreSQL forbids REFRESH ... CONCURRENTLY inside a function
 * (PreventInTransactionBlock), so the migration-108 helper fails on
 * standard managed Postgres even though some local builds allow it.
 * The SQL function is left in place but deliberately unused.
 *
 * Never throws — opportunistic in-process callers (approvals.js,
 * pricingOfferRepository.js) fire-and-forget and must not be taken down
 * by a refresh failure. Callers that need to know the outcome (the
 * nightly job) check the returned { refreshed } flag, mirroring
 * facAccumulationService.refreshAccumulation().
 *
 * @returns {Promise<{refreshed: boolean, error?: string}>}
 */
export async function refreshBenchmarks(client) {
  try {
    for (const view of BENCHMARK_VIEWS) {
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
    }
    logger.info('[ldf-benchmark] refreshed all views');
    return { refreshed: true };
  } catch (e) {
    logger.warn('[ldf-benchmark] refresh failed; views may be stale', { err: e.message });
    return { refreshed: false, error: e.message };
  }
}
