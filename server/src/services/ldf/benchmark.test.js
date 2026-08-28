// Tests for getBenchmarkLdfForClass scope selection and refreshBenchmarks.
// The DB client is mocked (dispatch on the MV name in the SQL) so no DB is
// touched. Regression focus (B7): the contract-count threshold is evaluated
// PER dev-month, so a sparse later dev-month can no longer ride the
// well-populated first row's count. Regression focus (testing-prep, findings
// 2+3): refreshBenchmarks issues the four REFRESH ... CONCURRENTLY statements
// as separate top-level queries (never via the migration-108 SQL function,
// which stock PostgreSQL rejects) and reports failure via { refreshed: false }
// instead of throwing.

import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../lib/logger.js';
import { getBenchmarkLdfForClass, refreshBenchmarks } from './benchmark.js';

function row(dev_month, n_contracts) {
  return {
    dev_month, n_contracts,
    weighted_ldf: 1.5, simple_ldf: 1.5, total_premium: 1000, stddev_ldf: 0.1,
  };
}

function makeClient({ country = [], region = [], global = [] }) {
  return {
    query: vi.fn(async (sql) => {
      if (sql.includes('mv_ldf_benchmark_country')) return { rows: country };
      if (sql.includes('mv_ldf_benchmark_region')) return { rows: region };
      if (sql.includes('mv_ldf_benchmark_global')) return { rows: global };
      return { rows: [] };
    }),
  };
}

const args = {
  classOfBusinessId: 'A', countryId: 'c1', region: 'r1',
  triangleType: 'PREMIUM', treatyCategory: 'PROPORTIONAL',
};

describe('getBenchmarkLdfForClass — scope threshold (per dev-month)', () => {
  it('accepts COUNTRY when EVERY dev-month row meets the threshold', async () => {
    const client = makeClient({ country: [row(12, 10), row(24, 8), row(36, 6)] });
    const out = await getBenchmarkLdfForClass(client, args);
    expect(out.scope).toBe('COUNTRY');
    expect(out.rows).toHaveLength(3);
  });

  it('a sparse later dev-month no longer rides the first row — falls back to REGION', async () => {
    // First row is well-populated (20) but the 120-month tail has only 2
    // contracts. Old code accepted COUNTRY off rows[0]; now it must fall back.
    const client = makeClient({
      country: [row(12, 20), row(24, 12), row(120, 2)],
      region: [row(12, 15), row(24, 9)],
    });
    const out = await getBenchmarkLdfForClass(client, args);
    expect(out.scope).toBe('REGION');
  });

  it('falls through to GLOBAL when neither country nor region fully qualifies', async () => {
    const client = makeClient({
      country: [row(12, 20), row(120, 1)],
      region: [row(12, 8), row(120, 2)],
      global: [row(12, 100), row(24, 90)],
    });
    const out = await getBenchmarkLdfForClass(client, args);
    expect(out.scope).toBe('GLOBAL');
  });

  it('GLOBAL is held to the SAME per-dev-month threshold — a sparse tail row means NONE (F69)', async () => {
    // The audit repro: a single-market class whose country dominates its
    // global pool. Country is rejected because its dev-36 row has only 4
    // contracts — and the global rows are the IDENTICAL dataset. The old
    // code accepted any non-empty GLOBAL result, handing the very same
    // sparse-tailed curve back relabelled 'GLOBAL'; it must now be NONE.
    const client = makeClient({
      country: [row(12, 6), row(24, 6), row(36, 4)],
      global: [row(12, 6), row(24, 6), row(36, 4)],
    });
    const out = await getBenchmarkLdfForClass(client, args);
    expect(out.scope).toBe('NONE');
    expect(out.rows).toEqual([]);
  });

  it('GLOBAL still qualifies when every dev-month row meets the threshold', async () => {
    const client = makeClient({
      global: [row(12, 5), row(24, 5), row(36, 5)],
    });
    const out = await getBenchmarkLdfForClass(client, args);
    expect(out.scope).toBe('GLOBAL');
    expect(out.rows).toHaveLength(3);
  });

  it('returns NONE when nothing is available anywhere', async () => {
    const client = makeClient({});
    const out = await getBenchmarkLdfForClass(client, args);
    expect(out.scope).toBe('NONE');
    expect(out.rows).toEqual([]);
  });

  it('returns NONE (no query) for a missing treaty category', async () => {
    const client = makeClient({ country: [row(12, 100)] });
    const out = await getBenchmarkLdfForClass(client, { ...args, treatyCategory: undefined });
    expect(out.scope).toBe('NONE');
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('refreshBenchmarks — separate top-level CONCURRENTLY statements', () => {
  it('refreshes the four views in dependency order and reports { refreshed: true }', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const calls = [];
    const client = { query: vi.fn(async (sql) => { calls.push(sql); return { rows: [] }; }) };

    const out = await refreshBenchmarks(client);

    expect(out).toEqual({ refreshed: true });
    expect(calls).toEqual([
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_contributions',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_country',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_region',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_global',
    ]);
    // Regression: must NOT go through the migration-108 SQL helper — stock
    // PostgreSQL forbids REFRESH ... CONCURRENTLY inside a function, so
    // SELECT public.refresh_ldf_benchmarks() fails on standard managed PG.
    expect(calls.some((sql) => sql.includes('refresh_ldf_benchmarks'))).toBe(false);
    info.mockRestore();
  });

  it('returns { refreshed: false, error } and warns — never throws — when the refresh fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = { query: vi.fn(async () => { throw new Error('connection refused'); }) };

    const out = await refreshBenchmarks(client);

    expect(out.refreshed).toBe(false);
    expect(out.error).toBe('connection refused');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
