import { describe, it, expect } from 'vitest';
import {
  calculateCdfs,
  projectToUltimate,
  calculatePattern,
  calculateAgeToAgeFactors,
  buildMatrixFromCells,
} from './chainLadder.js';

describe('calculateCdfs', () => {
  it('builds CDFs as the running product of pattern × ... × tail', () => {
    // pattern = [1.5, 1.2, 1.05], tail = 1.01
    //   cdf[3] = 1.01
    //   cdf[2] = 1.05 * 1.01           = 1.0605
    //   cdf[1] = 1.2  * 1.0605         = 1.2726
    //   cdf[0] = 1.5  * 1.2726         = 1.9089
    const cdfs = calculateCdfs([1.5, 1.2, 1.05], 1.01);
    expect(cdfs).toHaveLength(4);
    expect(cdfs[3]).toBeCloseTo(1.01, 10);
    expect(cdfs[2]).toBeCloseTo(1.0605, 10);
    expect(cdfs[1]).toBeCloseTo(1.2726, 10);
    expect(cdfs[0]).toBeCloseTo(1.9089, 10);
  });

  it('defaults tail to 1.0 when omitted', () => {
    const cdfs = calculateCdfs([1.2, 1.05]);
    expect(cdfs[2]).toBe(1.0);
    expect(cdfs[1]).toBeCloseTo(1.05, 10);
    expect(cdfs[0]).toBeCloseTo(1.26, 10);
  });

  it('empty pattern → single-element CDF array equal to the tail', () => {
    expect(calculateCdfs([], 1.05)).toEqual([1.05]);
  });
});

describe('projectToUltimate', () => {
  const matrix = [
    [100, 150, 158, 160], // 2020 — fully developed
    [110, 165, 174, null], // 2021
    [120, 180, null, null], // 2022
    [130, null, null, null], // 2023 — youngest
  ];
  const years = [2020, 2021, 2022, 2023];
  const pattern = [1.5, 1.05, 1.013];

  it('returns both cdfs and per-year projections', () => {
    const out = projectToUltimate(pattern, 1.0, { matrix, years });
    expect(out.cdfs).toHaveLength(4);
    expect(out.projections).toHaveLength(4);
    expect(out.projections[0].year).toBe(2020);
  });

  it('newest year (least developed) gets the largest CDF', () => {
    const out = projectToUltimate(pattern, 1.0, { matrix, years });
    expect(out.projections[3].cdf).toBeGreaterThan(out.projections[0].cdf);
  });

  it('handles a row with no data → ultimate = 0', () => {
    const m = [...matrix, [null, null, null, null]];
    const y = [...years, 2024];
    const out = projectToUltimate(pattern, 1.0, { matrix: m, years: y });
    expect(out.projections[4]).toMatchObject({
      year: 2024, latest: 0, cdf: 1, ultimate: 0, ibnr: 0,
    });
  });

  it('with no dataObj returns empty projections', () => {
    const out = projectToUltimate(pattern, 1.0);
    expect(out.cdfs).toEqual(calculateCdfs(pattern, 1.0));
    expect(out.projections).toEqual([]);
  });

  it('IBNR = ultimate − latest for each row', () => {
    const out = projectToUltimate(pattern, 1.0, { matrix, years });
    for (const p of out.projections) {
      expect(p.ibnr).toBeCloseTo(p.ultimate - p.latest, 10);
    }
  });
});

describe('calculatePattern (returns { pattern, warnings })', () => {
  it('returns the pattern + an empty warnings array when every column has ≥3 contributing rows', () => {
    // 4 origin years x 4 dev cols → columns 0..2 have 4, 3, 2 rows respectively.
    // Use a small matrix with all cells filled so column 2 (last) has the
    // most rows and columns 0..1 have 3+. Build 4 rows × 4 cols all filled.
    const matrix = [
      [100, 150, 158, 160],
      [110, 165, 174, 176],
      [120, 180, 190, 192],
      [130, 195, 206, 208],
    ];
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern, warnings } = calculatePattern(matrix, factors, 'weighted');
    expect(pattern).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it('emits a warning for any column with <3 contributing rows', () => {
    // Standard triangular shape: 4 origin years.
    //   2020 → 4 cells filled, contributes to col 0,1,2
    //   2021 → 3 cells filled, contributes to col 0,1
    //   2022 → 2 cells filled, contributes to col 0
    //   2023 → 1 cell  filled, contributes to nothing
    // → column 0: 3 rows (no warn), column 1: 2 rows (warn), column 2: 1 row (warn)
    const matrix = [
      [100, 150, 158, 160],
      [110, 165, 174, null],
      [120, 180, null, null],
      [130, null, null, null],
    ];
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern, warnings } = calculatePattern(matrix, factors, 'weighted');
    expect(pattern).toHaveLength(3);
    const warnedCols = warnings.map(w => w.column).sort();
    expect(warnedCols).toEqual([1, 2]);
    const w1 = warnings.find(w => w.column === 1);
    expect(w1.contributingRows).toBe(2);
    expect(w1.devPeriod).toBe('24→36');
    expect(w1.message).toMatch(/2 origin year/);
    const w2 = warnings.find(w => w.column === 2);
    expect(w2.contributingRows).toBe(1);
    expect(w2.devPeriod).toBe('36→48');
  });

  it('warns for last3 / last5 averages when fewer than 3 rows actually qualify', () => {
    // Only 2 rows — last3 / last5 still pull only those 2.
    const matrix = [
      [100, 150, 158],
      [110, 165, 174],
    ];
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern, warnings } = calculatePattern(matrix, factors, 'last3');
    expect(pattern).toHaveLength(2);
    expect(warnings.length).toBe(2); // both columns thin
    expect(warnings[0].contributingRows).toBe(2);
  });

  it('preserves the legacy LDF values produced by the previous (array-only) signature', () => {
    const matrix = [
      [100, 150, 158, 160],
      [110, 165, 174, null],
      [120, 180, null, null],
    ];
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern } = calculatePattern(matrix, factors, 'weighted');
    // col 0: (150+165+180)/(100+110+120) = 495/330 = 1.5
    expect(pattern[0]).toBeCloseTo(1.5, 10);
    // col 1: (158+174)/(150+165) = 332/315 ≈ 1.0540
    expect(pattern[1]).toBeCloseTo(332 / 315, 10);
  });
});

describe('calculatePattern — averaging methods', () => {
  // Five single-transition rows so column 0 has factors 1.5, 1.6, 1.3, 1.4, 1.2
  const matrix = [
    [100, 150], // 1.5
    [200, 320], // 1.6
    [100, 130], // 1.3
    [100, 140], // 1.4
    [100, 120], // 1.2
  ];
  const factors = calculateAgeToAgeFactors(matrix);

  it('weighted = Σnext / Σprev across all valid rows (volume-weighted)', () => {
    const { pattern } = calculatePattern(matrix, factors, 'weighted');
    // (150+320+130+140+120) / (100+200+100+100+100) = 860 / 600
    expect(pattern[0]).toBeCloseTo(860 / 600, 10);
  });

  it('simple = unweighted mean of the link ratios', () => {
    const { pattern } = calculatePattern(matrix, factors, 'simple');
    expect(pattern[0]).toBeCloseTo((1.5 + 1.6 + 1.3 + 1.4 + 1.2) / 5, 10); // 1.4
  });

  it('last3 = simple mean of the three most recent origin years', () => {
    const { pattern } = calculatePattern(matrix, factors, 'last3');
    expect(pattern[0]).toBeCloseTo((1.3 + 1.4 + 1.2) / 3, 10); // 1.3
  });

  it('last5 (exactly 5 rows) = simple mean of all five', () => {
    const { pattern } = calculatePattern(matrix, factors, 'last5');
    expect(pattern[0]).toBeCloseTo((1.5 + 1.6 + 1.3 + 1.4 + 1.2) / 5, 10);
  });

  it('drops excluded "r:c" cells before averaging (simple and weighted)', () => {
    const m = [[100, 150], [100, 160], [100, 130]]; // factors 1.5, 1.6, 1.3
    const f = calculateAgeToAgeFactors(m);
    const excluded = new Set(['1:0']); // drop the 1.6 outlier
    // simple mean of 1.5 and 1.3 = 1.4
    expect(calculatePattern(m, f, 'simple', { excluded }).pattern[0]).toBeCloseTo(1.4, 10);
    // weighted (150+130)/(100+100) = 1.4
    expect(calculatePattern(m, f, 'weighted', { excluded }).pattern[0]).toBeCloseTo(1.4, 10);
  });

  it('respects exclusions when slicing last3 (excluded rows are not "recent")', () => {
    // factors: 1.5, 1.6, 1.3, 1.4, 1.2 ; exclude the most-recent (1.2) → last3 of
    // the remaining = 1.6, 1.3, 1.4 → mean 1.4333…
    const { pattern } = calculatePattern(matrix, factors, 'last3', { excluded: new Set(['4:0']) });
    expect(pattern[0]).toBeCloseTo((1.6 + 1.3 + 1.4) / 3, 10);
  });
});

describe('buildMatrixFromCells — null cell handling', () => {
  const cells = [
    { origin_year: 2020, dev_months: 12, cum_value: 100 },
    { origin_year: 2020, dev_months: 24, cum_value: null },  // missing
    { origin_year: 2021, dev_months: 12, cum_value: 200 },
  ];

  it('preserves null cells in the auto-detect branch', () => {
    const { matrix } = buildMatrixFromCells(cells);
    expect(matrix[0][1]).toBeNull();  // 2020 / 24 months — was null
  });

  it('preserves null cells in the explicit-bounds branch', () => {
    // Pre-fix: this branch coerced null → 0, contaminating LDFs.
    const { matrix } = buildMatrixFromCells(cells, 2020, 2);
    expect(matrix[0][1]).toBeNull();
  });

  it('produces identical matrices from either call signature', () => {
    const auto = buildMatrixFromCells(cells);
    const explicit = buildMatrixFromCells(cells, 2020, 2);
    expect(explicit.matrix).toEqual(auto.matrix);
  });
});
