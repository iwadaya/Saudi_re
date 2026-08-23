// server/src/lib/cobCols.js — memoized schema introspection for the
// class_of_business table.
//
// Several routes need to know the live column names of class_of_business
// (deployments have drifted between class_of_business/class_name and
// class_of_business_id/class_id). The introspection result cannot change
// within a process — migrations run at boot — so it is cached for the
// process lifetime instead of hitting information_schema on every request
// (the same rationale as getCobCols in pricingAggregateRepository.js and
// the probes in modules/pricing/repositories/repositoryUtils.js).
//
// Failures are NOT cached: the promise slot is cleared so the next request
// retries, and the caller sees the original error exactly as it did when
// it ran the query itself.
import { pool } from '../db/pool.js';

let _namesPromise = null;

/**
 * Column names of public.class_of_business in ordinal order, cached per
 * process. Callers derive their own id/name/code picks from the list so
 * each keeps its historical fallback behaviour.
 *
 * @returns {Promise<string[]>}
 */
export function getCobColumnNames() {
  if (!_namesPromise) {
    _namesPromise = pool
      .query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='class_of_business'
          ORDER BY ordinal_position`
      )
      .then(({ rows }) => {
        // An empty result means the table doesn't exist yet (migrations
        // pending in an externally-migrated deployment) — don't pin that
        // state; retry on the next request so the cache heals itself.
        if (!rows.length) _namesPromise = null;
        return rows.map((r) => r.column_name);
      })
      .catch((err) => {
        _namesPromise = null;
        throw err;
      });
  }
  return _namesPromise;
}

let _marginPromise = null;

/**
 * Whether contract_pricing_outputs carries the optional margin columns
 * (actuarial_margin et al., added by a later migration). Cached per
 * process for the same reason as above.
 *
 * @returns {Promise<boolean>}
 */
export function hasPricingMarginColumns() {
  if (!_marginPromise) {
    _marginPromise = pool
      .query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='contract_pricing_outputs'
            AND column_name='actuarial_margin' LIMIT 1`
      )
      .then(({ rows }) => {
        const has = rows.length > 0;
        // Cache only the positive answer: a pre-migration `false` would
        // otherwise pin NULL margins until the process restarts.
        if (!has) _marginPromise = null;
        return has;
      })
      .catch((err) => {
        _marginPromise = null;
        throw err;
      });
  }
  return _marginPromise;
}
