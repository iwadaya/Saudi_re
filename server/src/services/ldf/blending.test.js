// Tests for computeBlendedLdfCurve and saveContractLdfBlend. The per-class
// benchmark lookup and the DB client are mocked so no DB is touched.
// Regression focus (B6): when no class carries any weight/premium the blend
// collapses to a flat CDF 1.0 — that must now be signalled via
// `degenerate: true` (and a logger.warn) instead of silently looking like a
// real "no development" curve.
// Regression focus (testing-prep, finding 1): saveContractLdfBlend must run
// its wipe-and-reinsert as ONE transaction on ONE dedicated connection —
// issuing BEGIN/COMMIT through the shared Pool spread the statements across
// connections, persisting truncated curves when a save failed mid-way.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../../lib/logger.js';
import { getBenchmarkLdfForClass } from './benchmark.js';
import { computeBlendedLdfCurve, saveContractLdfBlend } from './blending.js';

vi.mock('./benchmark.js', () => ({
  getBenchmarkLdfForClass: vi.fn(),
}));

// Benchmark curve keyed by class id — one dev_month at 12 for simplicity.
function benchFor(ldfByClass) {
  // getBenchmarkLdfForClass(client, { classOfBusinessId, ... }) — the class id
  // is on the SECOND (options) argument, not the first (client).
  return async (_client, { classOfBusinessId }) => ({
    scope: 'COUNTRY',
    countryId: 'c1',
    region: null,
    rows: [{ dev_month: 12, weighted_ldf: ldfByClass[classOfBusinessId], n_contracts: 10 }],
  });
}

const baseArgs = {
  countryId: 'c1', region: 'r1', triangleType: 'PREMIUM', treatyCategory: 'PROPORTIONAL',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeBlendedLdfCurve — normal (has-weight) path', () => {
  it('blends per EPI share and does not flag degenerate', async () => {
    getBenchmarkLdfForClass.mockImplementation(benchFor({ A: 2, B: 4 }));
    const warn = vi.spyOn(logger, 'warn');

    const out = await computeBlendedLdfCurve({}, {
      ...baseArgs,
      epiSplit: [
        { classOfBusinessId: 'A', premium: 75 },
        { classOfBusinessId: 'B', premium: 25 },
      ],
    });

    // 2·0.75 + 4·0.25 = 2.5
    expect(out.blended).toHaveLength(1);
    expect(out.blended[0].ldf).toBeCloseTo(2.5, 10);
    expect(out.blended[0].cdf).toBeCloseTo(2.5, 6);
    expect(out.degenerate).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('computeBlendedLdfCurve — degenerate (no weight) path', () => {
  it('flags degenerate + warns when all class premiums are 0', async () => {
    getBenchmarkLdfForClass.mockImplementation(benchFor({ A: 2 }));
    const warn = vi.spyOn(logger, 'warn');

    const out = await computeBlendedLdfCurve({}, {
      ...baseArgs,
      epiSplit: [{ classOfBusinessId: 'A', premium: 0 }],
    });

    // No weight → dev_month falls through to ldf 1.0 → flat CDF 1.0.
    expect(out.blended[0].ldf).toBe(1.0);
    expect(out.blended[0].cdf).toBe(1.0);
    expect(out.degenerate).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('empty epiSplit returns an explicit non-degenerate empty result', async () => {
    const out = await computeBlendedLdfCurve({}, { ...baseArgs, epiSplit: [] });
    expect(out).toEqual({ classes: [], blended: [], allDevMonths: [], degenerate: false });
  });
});

describe('saveContractLdfBlend — transactional wipe-and-reinsert', () => {
  const saveArgs = {
    contractId: 'CT1',
    triangleType: 'PREMIUM',
    overridden: false,
    classes: [{ classOfBusinessId: 'A', weight: 1, scope: 'COUNTRY', nContracts: 10 }],
    blended: [
      { devMonth: 12, ldf: 1.2, cdf: 1.44 },
      { devMonth: 24, ldf: 1.2, cdf: 1.2 },
    ],
  };

  // Fake dedicated client: records every statement, optionally fails on a
  // matching one (to simulate a mid-save error such as a FK violation).
  function makeFakeClient({ failOnSql = null } = {}) {
    const client = {
      sql: [],
      query: vi.fn(async (text) => {
        client.sql.push(text);
        if (failOnSql && text.includes(failOnSql)) {
          throw new Error(`forced failure: ${failOnSql}`);
        }
        if (text.includes('SELECT blend_id')) return { rows: [] }; // no prior blend
        if (text.includes('INSERT INTO public.contract_ldf_blend (')) {
          return { rows: [{ blend_id: 'B1' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return client;
  }

  // Fake Pool: hands out the dedicated client via connect(); its own query()
  // throws, because statements issued through the Pool can each land on a
  // DIFFERENT connection — the truncated-curve bug these tests pin down.
  function makeFakePool(client) {
    return {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => {
        throw new Error('saveContractLdfBlend must not run save statements on the shared pool');
      }),
    };
  }

  it('given the Pool, runs every statement on ONE dedicated client inside BEGIN…COMMIT, then releases it', async () => {
    const client = makeFakeClient();
    const fakePool = makeFakePool(client);

    const blendId = await saveContractLdfBlend(fakePool, saveArgs);

    expect(blendId).toBe('B1');
    expect(fakePool.connect).toHaveBeenCalledOnce();
    expect(fakePool.query).not.toHaveBeenCalled();
    expect(client.sql[0]).toBe('BEGIN');
    expect(client.sql[client.sql.length - 1]).toBe('COMMIT');
    // header select + insert, 1 weight row, 2 curve rows — all on the same client
    expect(client.sql.filter((s) => s.includes('contract_ldf_blend_weight'))).toHaveLength(1);
    expect(client.sql.filter((s) => s.includes('contract_ldf_blend_curve'))).toHaveLength(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('a failing insert mid-save rolls back on the same client — no partial rows can persist', async () => {
    const client = makeFakeClient({ failOnSql: 'contract_ldf_blend_curve' });
    const fakePool = makeFakePool(client);

    await expect(saveContractLdfBlend(fakePool, saveArgs)).rejects.toThrow('forced failure');

    // Everything before the failure ran inside BEGIN on this one connection,
    // so ROLLBACK undoes it all: the contract's saved blend is unchanged and
    // no truncated curve (header + partial rows) is persisted.
    expect(client.sql[0]).toBe('BEGIN');
    expect(client.sql[client.sql.length - 1]).toBe('ROLLBACK');
    expect(client.sql).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('given an existing transaction client, runs on it without nested BEGIN/COMMIT and never releases it', async () => {
    const client = makeFakeClient();

    const blendId = await saveContractLdfBlend(client, saveArgs);

    expect(blendId).toBe('B1');
    expect(client.sql).not.toContain('BEGIN');
    expect(client.sql).not.toContain('COMMIT');
    expect(client.sql.filter((s) => s.includes('contract_ldf_blend_curve'))).toHaveLength(2);
    expect(client.release).not.toHaveBeenCalled(); // caller owns the client's lifecycle
  });
});
