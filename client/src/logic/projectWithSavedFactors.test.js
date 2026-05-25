import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getTriangle: vi.fn(),
    getTriangleWithExclusions: vi.fn(),
    getDevFactors: vi.fn(),
    getContract: vi.fn(),
    getLargeLosses: vi.fn(),
    getCatLosses: vi.fn(),
    getStraightStats: vi.fn(),
    getLdfBlend: vi.fn(),
  },
}));

vi.mock('../api', () => ({ api: apiMock }));

import { loadProjectedRows } from './projectWithSavedFactors';

const cell = (year, dev, val) => ({ origin_year: year, dev_months: dev, cum_value: val });

// A single 2021 row observed only at dev 12. Full incurred (paid+OS) = 1000, of
// which a 400 large loss is stripped → attritional = 600. Saved INCURRED CDF at
// dev 12 = 1.5.
function primeApi({ strip = true, strippedDev12 = 600 } = {}) {
  apiMock.getTriangle.mockImplementation((_id, type) => {
    if (type === 'PREMIUM') return Promise.resolve({ cells: [cell(2021, 12, 2000)] });
    if (type === 'CLAIMS_PAID') return Promise.resolve({ cells: [cell(2021, 12, 1000)] });
    if (type === 'CLAIMS_OS') return Promise.resolve({ cells: [cell(2021, 12, 0)] });
    return Promise.resolve({ cells: [] });
  });
  apiMock.getTriangleWithExclusions.mockResolvedValue({
    full: { cells: [cell(2021, 12, 1000)] },
    stripped: { cells: [cell(2021, 12, strippedDev12)] },
    exclusions: {},
  });
  apiMock.getDevFactors.mockImplementation((_id, type) =>
    Promise.resolve(type === 'INCURRED' ? { factors: [{ dev_month: 12, chosen_cdf: 1.5 }] } : []),
  );
  apiMock.getContract.mockResolvedValue({ detail: { strip_large_cat_losses: strip } });
  apiMock.getLargeLosses.mockResolvedValue({ losses: [{ uw_year: 2021, incurred: 400 }] });
  apiMock.getCatLosses.mockResolvedValue({ losses: [] });
}

afterEach(() => vi.clearAllMocks());

describe('loadProjectedRows — attritional projection', () => {
  it('projects the stripped triangle and adds large/CAT back unprojected', async () => {
    primeApi({ strip: true });
    const { rows, source } = await loadProjectedRows('c1');
    expect(source).toBe('saved-factors');
    const r = rows.find(x => x.year === 2021);
    // attritional ultimate = 600 * 1.5 = 900; + large 400 (+ cat 0) = 1300.
    // NOT the full-triangle projection of 1000 * 1.5 = 1500.
    expect(r.ultLoss).toBe(1300);
    expect(r.ultIncurred).toBe(1300);
    // Actual incurred stays the raw full paid+OS latest diagonal.
    expect(r.actLoss).toBe(1000);
    // It applied the CDF to the stripped triangle, never the with-exclusions
    // INCURRED type was requested.
    expect(apiMock.getTriangleWithExclusions).toHaveBeenCalledWith('c1', 'INCURRED', undefined);
  });

  it('collapses to the full projection when stripping is off', async () => {
    // Stripping off → server returns the full triangle as `stripped`, loadings nil.
    primeApi({ strip: false, strippedDev12: 1000 });
    const { rows } = await loadProjectedRows('c1');
    const r = rows.find(x => x.year === 2021);
    // 1000 * 1.5 = 1500, no large/CAT added back.
    expect(r.ultLoss).toBe(1500);
    expect(r.actLoss).toBe(1000);
  });
});
