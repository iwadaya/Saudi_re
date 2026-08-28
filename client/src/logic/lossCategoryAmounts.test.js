// lossCategoryAmounts.test.js
//
// The large/CAT add-back population must match the population the server
// STRIPS from the attritional triangle. server/src/lib/triangleStripping.js
// strips ALL large + cat losses regardless of their is_selected flag
// (selection only drives the Pareto / loss-selection curves), so the client
// add-back must not filter deselected losses out — doing so removed a
// deselected loss from the projection base and never added it back,
// silently dropping the full loss amount from projected ultimates (the
// projection could even land BELOW the actual incurred diagonal).
//
// The end-to-end test runs the REAL server stripping (stripTriangleCells)
// against the REAL client projection (loadProjectedRows) — only the API
// transport is mocked.

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

import {
  stripTriangleCells,
  combineIncurredCells,
} from '../../../server/src/lib/triangleStripping.js';
import { loadLossCategoryByYear } from './lossCategoryAmounts';
import { loadProjectedRows } from './projectWithSavedFactors';

const cell = (year, dev, val) => ({ origin_year: year, dev_months: dev, cum_value: val });

afterEach(() => vi.clearAllMocks());

describe('loadLossCategoryByYear — add-back population', () => {
  it('includes DESELECTED (is_selected=false) losses — same population the server strips', async () => {
    apiMock.getLargeLosses.mockResolvedValue({
      losses: [
        { uw_year: 2023, incurred: 400, is_selected: false },
        { uw_year: 2023, incurred: 250, is_selected: true },
        { uw_year: 2022, paid: 100, os: 50 }, // no flag, no incurred → paid + os
      ],
    });
    apiMock.getCatLosses.mockResolvedValue({
      losses: [{ uw_year: 2023, incurred: 120, is_selected: false }],
    });
    const { large, cat } = await loadLossCategoryByYear('c1');
    expect(large.get(2023)).toBe(650); // 400 (deselected) + 250 (selected)
    expect(large.get(2022)).toBe(150); // paid + os fallback
    expect(cat.get(2023)).toBe(120);   // deselected CAT still added back
  });
});

describe('end-to-end: real server stripping + real client projection', () => {
  it('a deselected large loss stripped by the server is still added back to the ultimate', async () => {
    // 2023 row observed at dev 12: full incurred (paid + OS) = 1000, of which
    // a DESELECTED 400 large loss is stripped by the server. Saved INCURRED
    // CDF at dev 12 = 1.5.
    const deselectedLargeLoss = {
      uw_year: 2023,
      incurred: 400,
      is_selected: false,               // deselected on the Pareto screen
      date_of_loss: '2023-02-10',       // enters the triangle well before dev 12
    };
    const paidCells = [cell(2023, 12, 1000)];
    const osCells = [cell(2023, 12, 0)];

    // REAL server stripping — no is_selected filter, per its documented basis.
    const combined = combineIncurredCells(paidCells, osCells);
    const strippedCells = stripTriangleCells(combined, [deselectedLargeLoss], 'incurred');
    expect(strippedCells).toEqual([cell(2023, 12, 600)]); // 1000 − 400

    apiMock.getTriangle.mockImplementation((_id, type) => {
      if (type === 'PREMIUM') return Promise.resolve({ cells: [cell(2023, 12, 2000)] });
      if (type === 'CLAIMS_PAID') return Promise.resolve({ cells: paidCells });
      if (type === 'CLAIMS_OS') return Promise.resolve({ cells: osCells });
      return Promise.resolve({ cells: [] });
    });
    apiMock.getTriangleWithExclusions.mockResolvedValue({
      full: { cells: combined },
      stripped: { cells: strippedCells },
      exclusions: {},
    });
    apiMock.getDevFactors.mockImplementation((_id, type) =>
      Promise.resolve(type === 'INCURRED' ? { factors: [{ dev_month: 12, chosen_cdf: 1.5 }] } : []),
    );
    apiMock.getContract.mockResolvedValue({ detail: { strip_large_cat_losses: true } });
    apiMock.getLargeLosses.mockResolvedValue({ losses: [deselectedLargeLoss] });
    apiMock.getCatLosses.mockResolvedValue({ losses: [] });

    const { rows, source } = await loadProjectedRows('c1');
    expect(source).toBe('saved-factors');
    const r = rows.find((x) => x.year === 2023);

    // Hand-computed: attritional ultimate = 600 × 1.5 = 900, plus the 400
    // stripped (deselected) large loss added back = 1300.
    // The pre-fix client skipped the deselected loss in the add-back and
    // returned 900 — BELOW the actual incurred diagonal of 1000, a visibly
    // impossible projection.
    expect(r.ultLoss).toBe(1300);
    expect(r.actLoss).toBe(1000);
    expect(r.ultLoss).toBeGreaterThanOrEqual(r.actLoss);
  });
});
