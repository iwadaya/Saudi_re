// Pull weighted LDFs for a single (class, triangle_type) at the best scope
// the data supports. Returns the curve plus the scope decision so the UI
// can show "country (12 contracts)" or "region (fallback — only 3 contracts in KSA)".
import { logger } from '../../lib/logger.js';

const MIN_CONTRACTS_FOR_SCOPE = 5;

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
    if (country.rows.length > 0 &&
        country.rows[0].n_contracts >= MIN_CONTRACTS_FOR_SCOPE) {
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
    if (reg.rows.length > 0 &&
        reg.rows[0].n_contracts >= MIN_CONTRACTS_FOR_SCOPE) {
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

/**
 * Trigger a synchronous refresh of all benchmark views.
 * Called after a contract reaches a terminal underwriting state
 * (SIGNED / DECLINED / NTU), since each of those changes the
 * benchmark dataset. Safe to call repeatedly — CONCURRENTLY refresh
 * won't lock readers.
 */
export async function refreshBenchmarks(client) {
  try {
    await client.query('SELECT public.refresh_ldf_benchmarks()');
    logger.info('[ldf-benchmark] refreshed all views');
  } catch (e) {
    logger.warn('[ldf-benchmark] refresh failed; views may be stale', { err: e.message });
  }
}
