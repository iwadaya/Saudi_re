// server/tests/integration/ldfBenchmarkWeightedCounts.integration.test.js
//
// Migration 151 (audit F108) against a real database: the benchmark MVs'
// n_contracts must count only premium-weighted contributors — contracts
// whose class has a positive USD premium in contract_epi_split — because
// only those influence weighted_ldf. Before 151, a contract with no EPI
// split row counted toward the >= 5 per-dev-month scope-acceptance
// threshold while carrying zero weight in the number that prices.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { shouldSkipDb, seedRefs, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { getBenchmarkLdfForClass } from '../../src/services/ldf/benchmark.js';

describe.skipIf(shouldSkipDb)('integration: LDF benchmark n_contracts counts only weighted contributors (F108 / migration 151)', () => {
  // contract_class_of_business / contract_epi_split / contract_dev_factor
  // carry no FK on class_of_business_id, so fresh random class ids keep the
  // fixture rows invisible to every other class's benchmarks.
  const classA = randomUUID(); // 6 contracts, one without an EPI split
  const classB = randomUUID(); // 5 contracts, only one premium-bearing
  const contractIds = [];
  let refs;
  let region;

  async function seedContract({ classId, ldf, premium }) {
    const { rows } = await pool.query(
      `INSERT INTO public.contract
         (cedant_id, broker_id, country_id, currency_id, treaty_type_id,
          uw_year, inception_date, status)
       VALUES ($1,$2,$3,$4,$5, 2026, '2026-01-01', 'SIGNED')
       RETURNING contract_id`,
      [refs.cedant_id, refs.broker_id, refs.country_id, refs.currency_id, refs.treaty_type_id],
    );
    const id = rows[0].contract_id;
    contractIds.push(id);
    await pool.query(
      'INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id) VALUES ($1,$2)',
      [id, classId],
    );
    if (premium != null) {
      await pool.query(
        'INSERT INTO public.contract_epi_split (contract_id, class_of_business_id, premium) VALUES ($1,$2,$3)',
        [id, classId, premium],
      );
    }
    await pool.query(
      `INSERT INTO public.contract_dev_factor (contract_id, triangle_type, dev_month, selected_ldf)
       VALUES ($1, 'PREMIUM', 12, $2)`,
      [id, ldf],
    );
    return id;
  }

  beforeAll(async () => {
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    const { rows } = await pool.query(
      'SELECT region FROM public.country WHERE country_id = $1', [refs.country_id],
    );
    region = rows[0].region;

    // Class A — the audit's shape: 6 SIGNED contracts at dev 12, five
    // premium-bearing (8.0M total), one with NO contract_epi_split row and
    // an outlier LDF of 2.00 that weighted_ldf ignores entirely.
    const a = [
      { ldf: 1.5, premium: 4_000_000 },
      { ldf: 1.4, premium: 2_000_000 },
      { ldf: 1.3, premium: 1_000_000 },
      { ldf: 1.2, premium: 500_000 },
      { ldf: 1.1, premium: 500_000 },
      { ldf: 2.0, premium: null },      // counts for nothing that prices
    ];
    for (const c of a) await seedContract({ classId: classA, ...c });

    // Class B — 5 contracts at dev 12, only ONE with premium: before 151
    // this passed the >= 5 gate as n=5 while being a single-contract
    // weighted average.
    const b = [
      { ldf: 1.6, premium: 1_000_000 },
      { ldf: 1.5, premium: null },
      { ldf: 1.4, premium: null },
      { ldf: 1.3, premium: null },
      { ldf: 1.2, premium: null },
    ];
    for (const c of b) await seedContract({ classId: classB, ...c });

    await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_contributions');
    await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_benchmark_country');
    await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_benchmark_region');
    await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_benchmark_global');
  });

  afterAll(async () => {
    for (const id of contractIds) {
      try { await pool.query('DELETE FROM public.contract_dev_factor WHERE contract_id = $1', [id]); } catch { /* best effort */ }
      try { await pool.query('DELETE FROM public.contract WHERE contract_id = $1', [id]); } catch { /* cascades ccob + epi */ }
    }
    try {
      await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_contributions');
      await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_benchmark_country');
      await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_benchmark_region');
      await pool.query('REFRESH MATERIALIZED VIEW public.mv_ldf_benchmark_global');
    } catch { /* best effort */ }
    await closePools();
  });

  it('n_contracts = 5 (not 6) for the class with one unweighted contract; weighted_ldf ignores it', async () => {
    const { rows } = await pool.query(
      `SELECT n_contracts, total_premium, weighted_ldf, simple_ldf
         FROM public.mv_ldf_benchmark_global
        WHERE class_of_business_id = $1 AND triangle_type = 'PREMIUM'
          AND treaty_category = 'PROPORTIONAL' AND dev_month = 12`,
      [classA],
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    // Hand-derived: 5 premium-bearing contracts of the 6.
    expect(Number(r.n_contracts)).toBe(5);
    expect(Number(r.total_premium)).toBeCloseTo(8_000_000, 2);
    // weighted = (4·1.5 + 2·1.4 + 1·1.3 + 0.5·1.2 + 0.5·1.1)M / 8M
    //          = 11.25M / 8M = 1.40625 — the 2.00 outlier has no influence.
    expect(Number(r.weighted_ldf)).toBeCloseTo(1.40625, 8);
    // simple_ldf is untouched by 151: mean over ALL 6 = 8.5/6.
    expect(Number(r.simple_ldf)).toBeCloseTo(8.5 / 6, 8);
  });

  it('a 1-weighted-of-5 dev-month row reports n_contracts = 1 and no longer passes the scope gate', async () => {
    const { rows } = await pool.query(
      `SELECT n_contracts, weighted_ldf FROM public.mv_ldf_benchmark_country
        WHERE class_of_business_id = $1 AND country_id = $2
          AND triangle_type = 'PREMIUM' AND treaty_category = 'PROPORTIONAL'
          AND dev_month = 12`,
      [classB, refs.country_id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].n_contracts)).toBe(1);
    // The single premium-bearing contract IS the weighted average.
    expect(Number(rows[0].weighted_ldf)).toBeCloseTo(1.6, 8);

    // Through the service: 1 < 5 at country, region AND global (F69 applies
    // the same per-dev-month guard at GLOBAL), so the scope is NONE — a
    // 4-of-5-unweighted row can no longer price.
    const out = await getBenchmarkLdfForClass(pool, {
      classOfBusinessId: classB,
      countryId: refs.country_id,
      region,
      triangleType: 'PREMIUM',
      treatyCategory: 'PROPORTIONAL',
    });
    expect(out.scope).toBe('NONE');
    expect(out.rows).toEqual([]);
  });

  it('the economically-supported class still qualifies at COUNTRY with its weighted count', async () => {
    const out = await getBenchmarkLdfForClass(pool, {
      classOfBusinessId: classA,
      countryId: refs.country_id,
      region,
      triangleType: 'PREMIUM',
      treatyCategory: 'PROPORTIONAL',
    });
    expect(out.scope).toBe('COUNTRY');
    expect(out.rows).toHaveLength(1);
    expect(Number(out.rows[0].n_contracts)).toBe(5);
    expect(Number(out.rows[0].weighted_ldf)).toBeCloseTo(1.40625, 8);
  });
});
