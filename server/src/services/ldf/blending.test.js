// Tests for computeBlendedLdfCurve. The per-class benchmark lookup is mocked
// so no DB is touched. Regression focus (B6): when no class carries any
// weight/premium the blend collapses to a flat CDF 1.0 — that must now be
// signalled via `degenerate: true` (and a logger.warn) instead of silently
// looking like a real "no development" curve.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../../lib/logger.js';
import { getBenchmarkLdfForClass } from './benchmark.js';
import { computeBlendedLdfCurve } from './blending.js';

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
