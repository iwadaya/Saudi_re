// Tests for getBenchmarkLdfForClass scope selection. The DB client is mocked
// (dispatch on the MV name in the SQL) so no DB is touched. Regression focus
// (B7): the contract-count threshold is evaluated PER dev-month, so a sparse
// later dev-month can no longer ride the well-populated first row's count.

import { describe, it, expect, vi } from 'vitest';
import { getBenchmarkLdfForClass } from './benchmark.js';

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
